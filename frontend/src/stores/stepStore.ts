import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import type { RepairStep, RepairStepDraft } from '../types/step';
import type {
  ImportBatch,
  PositionReading,
  TimekeepingTest,
  TimekeepingTestDraft,
} from '../types/test';
import { isConfirmed, judgeTest } from '../types/test';
import { groupKeyOf, recalcAggregates } from '../utils/reconcile';

interface StepState {
  items: RepairStep[];
  tests: TimekeepingTest[];
  loaded: boolean;
}

/** 导入结果 */
export interface ImportResult {
  imported: number;
  skipped: number;
  failed: boolean;
  error: string;
}

export const useStepStore = defineStore('step', {
  state: (): StepState => ({ items: [], tests: [], loaded: false }),
  getters: {
    byClock: (state) => (clockId: string) =>
      state.items.filter((it) => it.clockId === clockId).sort((a, b) => a.seq - b.seq),
    testsByClock: (state) => (clockId: string) =>
      state.tests.filter((it) => it.clockId === clockId).sort((a, b) => b.testedAt - a.testedAt),
    /** 详情页历史：只显示已确认（归档）的走时结果 */
    confirmedByClock: (state) => (clockId: string) =>
      state.tests
        .filter((it) => it.clockId === clockId && isConfirmed(it))
        .sort((a, b) => b.testedAt - a.testedAt),
    /** 待对账候选：未确认的走时结果 */
    candidatesByClock: (state) => (clockId: string) =>
      state.tests
        .filter((it) => it.clockId === clockId && !isConfirmed(it))
        .sort((a, b) => b.testedAt - a.testedAt),
  },
  actions: {
    async load() {
      const steps = await db.steps.toArray();
      steps.sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
      this.items = steps;
      const tests = await db.tests.toArray();
      this.tests = tests.sort((a, b) => b.testedAt - a.testedAt);
      this.loaded = true;
    },
    async add(draft: RepairStepDraft) {
      const record: RepairStep = { ...toPlain(draft), id: newId('stp') };
      await db.steps.put(toPlain(record));
      this.items = [...this.items, record];
      return record;
    },
    async finish(id: string) {
      const patch: Partial<RepairStep> = { state: 'done', finishedAt: Date.now() };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    },
    async rollback(id: string) {
      const patch: Partial<RepairStep> = { state: 'rolledback', finishedAt: undefined };
      await db.steps.update(id, patch);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...patch } : it));
    },
    /** 上下移动排序：交换两个相邻步骤的 seq */
    async swapSeq(aId: string, bId: string) {
      const a = this.items.find((it) => it.id === aId);
      const b = this.items.find((it) => it.id === bId);
      if (!a || !b) return;
      const aSeq = a.seq;
      await db.steps.update(a.id, { seq: b.seq });
      await db.steps.update(b.id, { seq: aSeq });
      this.items = this.items.map((it) => {
        if (it.id === a.id) return { ...it, seq: b.seq };
        if (it.id === b.id) return { ...it, seq: aSeq };
        return it;
      });
    },
    async addTest(draft: TimekeepingTestDraft) {
      const record: TimekeepingTest = { ...toPlain(draft), id: newId('tst') };
      await db.tests.put(toPlain(record));
      this.tests = [record, ...this.tests];
      return record;
    },
    /**
     * 导入一批走时记录（校表仪 / 纸单）。
     * 幂等：同批次号 + 同藏品号 + 同测试时间的记录已存在则跳过，重试不重复新增。
     * @param simulateFailure 模拟导入中途失败（用于演示「失败后重试不重复」）
     */
    async importBatch(batch: ImportBatch, simulateFailure = false): Promise<ImportResult> {
      let imported = 0;
      let skipped = 0;
      try {
        let savedThisRun = 0;
        for (const draft of batch.records) {
          const key = `${draft.clockNo ?? ''}__${draft.testedAt}`;
          const exists = this.tests.some(
            (t) => t.batchId === batch.batchId && groupKeyOf(t) === key,
          );
          if (exists) {
            skipped += 1;
            continue;
          }
          const record: TimekeepingTest = {
            ...toPlain(draft),
            id: newId('tst'),
            source: batch.source,
            confirmed: false,
            batchId: batch.batchId,
          };
          await db.tests.put(toPlain(record));
          this.tests = [record, ...this.tests];
          imported += 1;
          savedThisRun += 1;
          // 模拟中途失败：第 1 条新记录写入后报错，重试时已写入的记录应被跳过
          if (simulateFailure && savedThisRun === 1) {
            throw new Error('模拟导入失败：第 1 条记录写入后校验未通过，请重试');
          }
        }
        if (simulateFailure) throw new Error('模拟导入失败（校验未通过）');
        return { imported, skipped, failed: false, error: '' };
      } catch (e) {
        return {
          imported,
          skipped,
          failed: true,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
    /**
     * 确认采用某条候选结果：
     * 把用户选定的方位读数写入归档记录（无归档则以候选新建归档），
     * 重算均值与结论，并清理同组其余候选。
     */
    async confirmTest(candidateId: string, adoptedPositions: PositionReading[]) {
      const candidate = this.tests.find((t) => t.id === candidateId);
      if (!candidate) return;
      const group = this.tests.filter((t) => groupKeyOf(t) === groupKeyOf(candidate));
      const archive = group.find((t) => isConfirmed(t));
      const { rate, amplitude, beatError } = recalcAggregates(adoptedPositions);
      const conclusion = judgeTest(rate, beatError, amplitude);

      if (archive) {
        const patch: Partial<TimekeepingTest> = {
          positions: adoptedPositions,
          rate,
          amplitude,
          beatError,
          conclusion,
          confirmed: true,
        };
        await db.tests.update(archive.id, toPlain(patch));
        this.tests = this.tests.map((t) => (t.id === archive.id ? { ...t, ...patch } : t));
      } else {
        const patch: Partial<TimekeepingTest> = {
          positions: adoptedPositions,
          rate,
          amplitude,
          beatError,
          conclusion,
          confirmed: true,
        };
        await db.tests.update(candidate.id, toPlain(patch));
        this.tests = this.tests.map((t) => (t.id === candidate.id ? { ...t, ...patch } : t));
      }

      // 清理同组其余候选（已被本次采用覆盖）
      const staleIds = group
        .filter((t) => t.id !== (archive?.id ?? candidate.id) && !isConfirmed(t))
        .map((t) => t.id);
      if (staleIds.length > 0) {
        await db.tests.bulkDelete(staleIds);
        this.tests = this.tests.filter((t) => !staleIds.includes(t.id));
      }
    },
    /** 丢弃一条候选结果 */
    async rejectTest(candidateId: string) {
      await db.tests.delete(candidateId);
      this.tests = this.tests.filter((t) => t.id !== candidateId);
    },
    async removeTest(id: string) {
      await db.tests.delete(id);
      this.tests = this.tests.filter((it) => it.id !== id);
    },
  },
});
