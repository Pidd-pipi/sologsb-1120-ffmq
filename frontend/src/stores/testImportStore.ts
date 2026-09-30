import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { hashContent, minuteKeyOf, newId } from '../utils/id';
import type { Clock } from '../types/clock';
import {
  TEST_POSITIONS,
  type PartialPositionReading,
  type PositionReading,
  type RawTestImport,
  type TestPosition,
} from '../types/test';
import {
  applyReconcile,
  buildReconcileGroups,
  type ReconcileDecision,
  type ReconcileGroup,
} from '../utils/reconcile';

interface ImportState {
  rows: RawTestImport[];
  loaded: boolean;
}

interface ParsedRow {
  clockId: string;
  testedAt: number;
  positions: PositionReading[];
  powerReserve: number;
  conclusion: string;
}

export interface ImportResult {
  ok: boolean;
  errors: string[];
  added: number;
  skipped: number;
  /** 整批此前已导入过（重试同批） */
  batchReplayed: boolean;
}

/** 行内容指纹的规范化载荷，字段顺序固定，保证幂等 */
function rowPayload(row: ParsedRow, source: RawTestImport['source']) {
  return {
    clockId: row.clockId,
    minuteKey: minuteKeyOf(row.testedAt),
    testedAt: row.testedAt,
    source,
    positions: row.positions
      .map((r) => ({ ...r }))
      .sort((a, b) => TEST_POSITIONS.indexOf(a.position) - TEST_POSITIONS.indexOf(b.position)),
    powerReserve: row.powerReserve,
    conclusion: row.conclusion,
  };
}

function parseTestedAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const ts = new Date(value.trim()).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 解析一批导入文本。任何一行不合格都返回错误，整批不写库——
 * 修复师改完后可原样重试，已成功的部分不会重复落库。
 */
function parseInput(
  label: string,
  text: string,
  source: RawTestImport['source'],
  clockByNo: Map<string, Clock>,
): { rows: ParsedRow[]; errors: string[] } {
  const errors: string[] = [];
  const rows: ParsedRow[] = [];
  if (!text.trim()) return { rows, errors };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { rows, errors: [`${label}：JSON 解析失败（${(e as Error).message}）`] };
  }
  if (!Array.isArray(data)) {
    return { rows, errors: [`${label}：内容必须是 JSON 数组，每行一轮测试`] };
  }

  data.forEach((item, index) => {
    const where = (reason: string) => errors.push(`${label} 第 ${index + 1} 行：${reason}`);
    if (typeof item !== 'object' || item === null) {
      where('不是有效对象');
      return;
    }
    const obj = item as Record<string, unknown>;

    const clockNo = typeof obj.clockNo === 'string' ? obj.clockNo.trim() : '';
    if (!clockNo) {
      where('缺少藏品号 clockNo');
      return;
    }
    const clock = clockByNo.get(clockNo);
    if (!clock) {
      where(`藏品号「${clockNo}」在台账中不存在`);
      return;
    }

    const testedAt = parseTestedAt(obj.testedAt);
    if (testedAt === null) {
      where('测试时间 testedAt 无法识别（支持毫秒时间戳或日期字符串）');
      return;
    }

    const powerReserve = obj.powerReserve === undefined ? 0 : obj.powerReserve;
    if (!isFiniteNumber(powerReserve) || powerReserve < 0) {
      where('动力储备 powerReserve 必须是不小于 0 的数字');
      return;
    }
    const conclusion = obj.conclusion === undefined ? '' : String(obj.conclusion);

    if (!Array.isArray(obj.positions) || obj.positions.length === 0) {
      where('positions 必须是非空数组（允许只填部分方位）');
      return;
    }

    const seen = new Set<TestPosition>();
    const readings: PositionReading[] = [];
    let positionsValid = true;
    for (const p of obj.positions as PartialPositionReading[]) {
      if (typeof p !== 'object' || p === null) {
        where('positions 中存在无效读数');
        positionsValid = false;
        break;
      }
      if (!TEST_POSITIONS.includes(p.position as TestPosition)) {
        where(`方位「${String(p.position)}」无效，应为 ${TEST_POSITIONS.join(' / ')}`);
        positionsValid = false;
        break;
      }
      if (seen.has(p.position as TestPosition)) {
        where(`方位「${p.position}」重复`);
        positionsValid = false;
        break;
      }
      if (!isFiniteNumber(p.rate) || !isFiniteNumber(p.amplitude) || !isFiniteNumber(p.beatError)) {
        where(`方位「${p.position}」的日差 / 摆幅 / 偏振必须都是数字`);
        positionsValid = false;
        break;
      }
      if (p.amplitude < 0 || p.amplitude > 400 || p.beatError < 0 || p.beatError > 9.9) {
        where(`方位「${p.position}」读数超出合理范围（摆幅 0–400°，偏振 0–9.9ms）`);
        positionsValid = false;
        break;
      }
      seen.add(p.position as TestPosition);
      readings.push({
        position: p.position as TestPosition,
        rate: p.rate,
        amplitude: p.amplitude,
        beatError: p.beatError,
      });
    }
    if (!positionsValid) return;

    rows.push({ clockId: clock.id, testedAt, positions: readings, powerReserve, conclusion });
  });

  return { rows, errors };
}

export const useTestImportStore = defineStore('testImport', {
  state: (): ImportState => ({ rows: [], loaded: false }),
  getters: {
    pendingRows: (state) => state.rows.filter((r) => !r.consumed),
    groups(state): ReconcileGroup[] {
      return buildReconcileGroups(state.rows);
    },
  },
  actions: {
    async load() {
      this.rows = await db.testImports.orderBy('testedAt').reverse().toArray();
      this.loaded = true;
    },
    groupsForClock(clockId: string): ReconcileGroup[] {
      return buildReconcileGroups(this.rows).filter((g) => g.clockId === clockId);
    },
    /**
     * 导入一批校表仪 / 纸单文本。
     * 先全量校验再在一个事务内写入：失败可重试；
     * 同批指纹或行内容指纹已存在时跳过，重试不重复新增。
     */
    async importBatch(machineText: string, paperText: string, clocks: Clock[]): Promise<ImportResult> {
      const clockByNo = new Map(clocks.map((c) => [c.clockNo, c]));
      const machine = parseInput('校表仪', machineText, 'machine', clockByNo);
      const paper = parseInput('纸单', paperText, 'paper', clockByNo);
      const errors = [...machine.errors, ...paper.errors];
      if (errors.length > 0) {
        return { ok: false, errors, added: 0, skipped: 0, batchReplayed: false };
      }
      const allEmpty = machine.rows.length === 0 && paper.rows.length === 0;
      if (allEmpty) {
        return { ok: false, errors: ['两栏均为空，请至少粘贴一份结果'], added: 0, skipped: 0, batchReplayed: false };
      }

      // 批次指纹：同一份文本重试时稳定不变
      const batchHash = hashContent([machineText.trim(), paperText.trim()].join('\n#SEP#\n'));
      const now = Date.now();

      let added = 0;
      let skipped = 0;
      let batchReplayed = false;

      await db.transaction('rw', db.testImports, async () => {
        const seenBatch = await db.testImports.where('batchHash').equals(batchHash).first();
        if (seenBatch) batchReplayed = true;

        const collect = async (parsed: ParsedRow[], source: RawTestImport['source']) => {
          for (const row of parsed) {
            const payload = rowPayload(row, source);
            const rowHash = hashContent(JSON.stringify(payload));
            const duplicate = await db.testImports.where('rowHash').equals(rowHash).first();
            if (duplicate) {
              skipped += 1;
              continue;
            }
            const record: RawTestImport = {
              id: newId('imp'),
              ...payload,
              batchHash,
              rowHash,
              importedAt: now,
            };
            await db.testImports.add(toPlain(record));
            this.rows = [record, ...this.rows];
            added += 1;
          }
        };
        await collect(machine.rows, 'machine');
        await collect(paper.rows, 'paper');
      });

      return { ok: added > 0, errors, added, skipped, batchReplayed };
    },
    /** 确认对账：更新或新建正式记录，两源原始行标记 consumed（保留供重试去重） */
    async confirmReconcile(decision: ReconcileDecision): Promise<string> {
      const draft = applyReconcile(decision);
      const { group } = decision;
      const rawIds = [group.machine?.id, group.paper?.id].filter((id): id is string => Boolean(id));

      let testId = '';
      await db.transaction('rw', db.tests, db.testImports, async () => {
        const existing = await db.tests
          .where('clockId')
          .equals(group.clockId)
          .filter((t) => minuteKeyOf(t.testedAt) === group.minuteKey)
          .first();
        testId = existing?.id ?? newId('tst');
        await db.tests.put(toPlain({ ...draft, id: testId }));
        for (const rawId of rawIds) {
          await db.testImports.update(rawId, { consumed: true });
        }
      });

      this.rows = this.rows.map((r) => (rawIds.includes(r.id) ? { ...r, consumed: true } : r));
      return testId;
    },
    /** 放弃对账：不生成正式记录，原始行同样标记 consumed */
    async discardGroup(group: ReconcileGroup): Promise<void> {
      const rawIds = [group.machine?.id, group.paper?.id].filter((id): id is string => Boolean(id));
      await db.transaction('rw', db.testImports, async () => {
        for (const rawId of rawIds) {
          await db.testImports.update(rawId, { consumed: true });
        }
      });
      this.rows = this.rows.map((r) => (rawIds.includes(r.id) ? { ...r, consumed: true } : r));
    },
  },
});
