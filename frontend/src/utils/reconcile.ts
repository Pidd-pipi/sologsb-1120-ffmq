import {
  BEAT_DIFF_TOLERANCE,
  RATE_DIFF_TOLERANCE,
  TEST_POSITIONS,
  judgeTest,
  type PositionReading,
  type RawTestImport,
  type TestPosition,
  type TestSource,
  type TimekeepingTestDraft,
} from '../types/test';
import { avgAmplitude, avgBeatError, avgRate } from './timeCalc';

export type PositionChoiceValue = 'machine' | 'paper';
export type ScalarChoiceValue = PositionChoiceValue | 'none';

export interface PositionChoice {
  position: TestPosition;
  machine?: PositionReading;
  paper?: PositionReading;
  /** 校表仪有、纸单缺（或反之） */
  missing: boolean;
  /** 日差相差超过 1 s/d */
  rateConflict: boolean;
  /** 偏振相差超过 0.5 ms */
  beatConflict: boolean;
  /** 修复师确认采用哪一值 */
  chosen: PositionChoiceValue;
}

/** 一组待对账结果：同藏品号、同一测试分钟的校表仪 + 纸单记录 */
export interface ReconcileGroup {
  key: string;
  clockId: string;
  minuteKey: string;
  machine?: RawTestImport;
  paper?: RawTestImport;
  testedAt: number;
  choices: PositionChoice[];
  missingCount: number;
  conflictCount: number;
  powerChoice: ScalarChoiceValue;
  timeChoice: ScalarChoiceValue;
  /** 纸单上手写的结论，供参考 */
  paperConclusion: string;
}

/** 缺方位或数值超差时需要修复师定夺的方位数 */
export function needsDecision(choice: PositionChoice): boolean {
  return choice.missing || choice.rateConflict || choice.beatConflict;
}

function readingOf(row: RawTestImport, position: TestPosition): PositionReading | undefined {
  return row.positions.find((r) => r.position === position);
}

/** 把一批原始导入按藏品号 + 测试分钟归组 */
export function buildReconcileGroups(rows: RawTestImport[]): ReconcileGroup[] {
  const active = rows.filter((r) => !r.consumed);
  const map = new Map<string, ReconcileGroup>();

  for (const row of active) {
    const key = `${row.clockId}@${row.minuteKey}`;
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        clockId: row.clockId,
        minuteKey: row.minuteKey,
        testedAt: row.testedAt,
        choices: [],
        missingCount: 0,
        conflictCount: 0,
        powerChoice: 'none',
        timeChoice: 'none',
        paperConclusion: '',
      };
      map.set(key, group);
    }
    if (row.source === 'machine') {
      group.machine = row;
    } else {
      group.paper = row;
    }
  }

  for (const group of map.values()) {
    if (group.machine) group.testedAt = group.machine.testedAt;
    group.paperConclusion = group.paper?.conclusion ?? '';
    group.powerChoice = group.machine && group.paper ? 'machine' : group.machine ? 'machine' : 'paper';
    group.timeChoice = group.machine ? 'machine' : 'paper';

    for (const position of TEST_POSITIONS) {
      const machine = group.machine ? readingOf(group.machine, position) : undefined;
      const paper = group.paper ? readingOf(group.paper, position) : undefined;
      const overTolerance = (pick: (r: PositionReading) => number, tolerance: number) =>
        Boolean(machine && paper && Math.abs(pick(machine) - pick(paper)) > tolerance);
      const rateConflict = overTolerance((r) => r.rate, RATE_DIFF_TOLERANCE);
      const beatConflict = overTolerance((r) => r.beatError, BEAT_DIFF_TOLERANCE);
      const missing = !machine || !paper;
      // 两值都在且不超差时默认取校表仪；缺方位或超差时同样预选一值，修复师可改选
      const chosen: PositionChoiceValue = machine ? 'machine' : 'paper';
      if (missing) group.missingCount += 1;
      if (rateConflict || beatConflict) group.conflictCount += 1;
      group.choices.push({ position, machine, paper, missing, rateConflict, beatConflict, chosen });
    }
  }

  return [...map.values()].sort((a, b) => b.testedAt - a.testedAt);
}

export interface ReconcileDecision {
  group: ReconcileGroup;
  choices: PositionChoice[];
  powerChoice: ScalarChoiceValue;
  timeChoice: ScalarChoiceValue;
  customConclusion: string;
}

/** 按修复师的选择合并出最终读数 */
function mergeReadings(decision: ReconcileDecision): PositionReading[] {
  const readings: PositionReading[] = [];
  for (const choice of decision.choices) {
    const picked = choice.chosen === 'machine' ? choice.machine : choice.paper;
    if (!picked) continue; // 两源都没有的方位直接舍弃
    readings.push({ ...picked, position: choice.position });
  }
  return readings;
}

/**
 * 应用对账结论：重算均值与结论，生成正式记录草稿。
 * 旧测试的 conclusion 原样保留；对账确认的记录一律按新均值重算判定，
 * 修复师也可在手填结论中覆盖。
 */
export function applyReconcile(decision: ReconcileDecision): TimekeepingTestDraft {
  const { group } = decision;
  const positions = mergeReadings(decision);
  const rate = avgRate(positions);
  const amplitude = avgAmplitude(positions);
  const beatError = avgBeatError(positions);

  const powerSourceRow =
    decision.powerChoice === 'machine'
      ? group.machine
      : decision.powerChoice === 'paper'
        ? group.paper
        : group.machine ?? group.paper;
  const timeSourceRow = decision.timeChoice === 'paper' ? group.paper : (group.machine ?? group.paper);

  const conclusion = decision.customConclusion.trim()
    ? decision.customConclusion.trim()
    : judgeTest(rate, beatError, amplitude);

  const sources: TestSource[] = [
    ...new Set(
      decision.choices
        .map((c) => (c.chosen === 'machine' ? group.machine : group.paper)?.source)
        .filter((s): s is 'machine' | 'paper' => Boolean(s)),
    ),
  ];

  return {
    clockId: group.clockId,
    testedAt: timeSourceRow?.testedAt ?? group.testedAt,
    amplitude,
    beatError,
    rate,
    positions,
    powerReserve: powerSourceRow?.powerReserve ?? 0,
    conclusion,
    status: 'confirmed',
    source: sources.length === 1 ? sources[0] : 'mixed',
    mergedFrom: [group.machine?.id, group.paper?.id].filter((id): id is string => Boolean(id)),
  };
}

/** 对账均值预览（确认弹窗实时联动） */
export function previewAverages(decision: ReconcileDecision) {
  const positions = mergeReadings(decision);
  return {
    rate: avgRate(positions),
    amplitude: avgAmplitude(positions),
    beatError: avgBeatError(positions),
    count: positions.length,
  };
}
