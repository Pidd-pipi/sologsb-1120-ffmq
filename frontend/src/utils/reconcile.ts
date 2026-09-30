import type {
  PositionConflict,
  PositionReading,
  TestPosition,
  TimekeepingTest,
} from '../types/test';
import { detectPositionConflict, isConfirmed, sourceOf } from '../types/test';
import { avgAmplitude, avgBeatError, avgRate } from './timeCalc';

/** 对账分组键：按藏品号 + 测试时间对账 */
export function groupKeyOf(test: TimekeepingTest): string {
  return `${test.clockNo ?? ''}__${test.testedAt}`;
}

export interface ReconciliationGroup {
  key: string;
  clockNo: string;
  testedAt: number;
  /** 已确认归档的记录（每组至多一条） */
  archive: TimekeepingTest | undefined;
  /** 待确认的候选记录 */
  candidates: TimekeepingTest[];
  /** 组内全部记录 */
  all: TimekeepingTest[];
}

/**
 * 把走时记录按「藏品号 + 测试时间」分组，拆出归档记录与候选记录。
 * 只返回含候选（待对账）的分组。
 */
export function buildReconciliationGroups(tests: TimekeepingTest[]): ReconciliationGroup[] {
  const map = new Map<string, ReconciliationGroup>();
  for (const t of tests) {
    const key = groupKeyOf(t);
    let g = map.get(key);
    if (!g) {
      g = { key, clockNo: t.clockNo ?? '', testedAt: t.testedAt, archive: undefined, candidates: [], all: [] };
      map.set(key, g);
    }
    g.all.push(t);
    if (isConfirmed(t)) {
      if (!g.archive) g.archive = t;
    } else {
      g.candidates.push(t);
    }
  }
  return Array.from(map.values())
    .filter((g) => g.candidates.length > 0)
    .sort((a, b) => b.testedAt - a.testedAt);
}

/** 候选记录的对账参照：优先取同组归档记录，否则取另一条候选 */
export function referenceOf(group: ReconciliationGroup, candidate: TimekeepingTest): TimekeepingTest | undefined {
  if (group.archive && group.archive.id !== candidate.id) return group.archive;
  return group.all.find((t) => t.id !== candidate.id);
}

/** 按方位建立读数索引 */
function positionMap(test: TimekeepingTest | undefined): Map<TestPosition, PositionReading> {
  const m = new Map<TestPosition, PositionReading>();
  if (!test) return m;
  for (const r of test.positions) m.set(r.position, r);
  return m;
}

export interface PositionDiffRow {
  position: TestPosition;
  candidate: PositionReading | undefined;
  reference: PositionReading | undefined;
  conflict: PositionConflict;
  /** 该方位是否需要二选一（缺方位或数值冲突） */
  needChoice: boolean;
}

/**
 * 生成候选 vs 参照的方位对账行。
 * 缺方位、日差相差 >1s、偏振相差 >0.5ms 都会标为 needChoice，保留两值供选择。
 */
export function buildPositionDiffs(
  candidate: TimekeepingTest,
  reference: TimekeepingTest | undefined,
): PositionDiffRow[] {
  const candMap = positionMap(candidate);
  const refMap = positionMap(reference);
  const positions = Array.from(new Set<TestPosition>([...candMap.keys(), ...refMap.keys()]));
  return positions.map((position) => {
    const c = candMap.get(position);
    const r = refMap.get(position);
    const conflict = detectPositionConflict(c, r);
    return {
      position,
      candidate: c,
      reference: r,
      conflict,
      needChoice: conflict.missing || conflict.rateConflict || conflict.beatErrorConflict,
    };
  });
}

/** 采用方：候选 or 参照 */
export type AdoptSide = 'candidate' | 'reference';

/**
 * 依据用户在各冲突方位的选择，拼出最终归档方位读数。
 * - 双方一致（无冲突）：取参照值
 * - 仅一方有值（缺方位）：取有值一方
 * - 双方冲突：取用户选择的一方
 */
export function buildAdoptedPositions(
  candidate: TimekeepingTest,
  reference: TimekeepingTest | undefined,
  choices: Partial<Record<TestPosition, AdoptSide>>,
): PositionReading[] {
  const rows = buildPositionDiffs(candidate, reference);
  return rows.map((row) => {
    if (!row.needChoice) {
      return { ...(row.reference ?? row.candidate!) };
    }
    if (row.conflict.missing) {
      return { ...(row.candidate ?? row.reference!) };
    }
    const side = choices[row.position] ?? 'candidate';
    return { ...(side === 'candidate' ? row.candidate! : row.reference!) };
  });
}

/** 依据方位读数重算均值与结论 */
export function recalcAggregates(positions: PositionReading[]): {
  rate: number;
  amplitude: number;
  beatError: number;
} {
  return {
    rate: avgRate(positions),
    amplitude: avgAmplitude(positions),
    beatError: avgBeatError(positions),
  };
}

/** 取记录来源文案（用于对账面板列头） */
export function sourceLabel(test: TimekeepingTest | undefined): string {
  if (!test) return '—';
  return sourceOf(test) === 'timegrapher' ? '校表仪' : sourceOf(test) === 'paper' ? '纸单' : '原档案';
}
