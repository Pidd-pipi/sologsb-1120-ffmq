// Store 层测试：导入幂等（重试不重复）、确认采用重算、详情页只显示已确认
import 'fake-indexeddb/auto';
import { setActivePinia, createPinia } from 'pinia';
import { useStepStore } from '../frontend/src/stores/stepStore';
import { db } from '../frontend/src/utils/db';
import type { ImportBatch, PositionReading, TimekeepingTestDraft } from '../frontend/src/types/test';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`❌ FAIL: ${msg}`);
  }
}
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.error(`❌ FAIL: ${msg}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

function mkPositions(rateBase: number): PositionReading[] {
  return [
    { position: '面上', rate: rateBase, amplitude: 260, beatError: 0.4 },
    { position: '面下', rate: rateBase + 1, amplitude: 258, beatError: 0.5 },
    { position: '12上', rate: rateBase + 0.5, amplitude: 262, beatError: 0.4 },
    { position: '6上', rate: rateBase + 0.8, amplitude: 256, beatError: 0.4 },
  ];
}

function mkDraft(clockId: string, clockNo: string, testedAt: number, rateBase: number): TimekeepingTestDraft {
  const positions = mkPositions(rateBase);
  return {
    clockId,
    clockNo,
    testedAt,
    amplitude: 260,
    beatError: 0.4,
    rate: rateBase + 0.6,
    powerReserve: 40,
    conclusion: '',
    positions,
  };
}

async function main() {
  setActivePinia(createPinia());
  const store = useStepStore();

  // 清空库
  await db.tests.clear(); store.tests = [];

  const testedAt = 1000000;
  const batch: ImportBatch = {
    batchId: 'BATCH-TEST-001',
    source: 'timegrapher',
    records: [
      mkDraft('clk1', 'CLK-001', testedAt, 5.0),
      mkDraft('clk1', 'CLK-001', testedAt + 1000, 6.0),
    ],
  };

  // 1. 首次导入：新增 2 条
  let result = await store.importBatch(batch);
  assertEq(result.imported, 2, '首次导入新增 2 条');
  assertEq(result.skipped, 0, '首次导入跳过 0 条');
  assertEq(result.failed, false, '首次导入未失败');
  assertEq(store.tests.length, 2, '库中 2 条记录');
  assert(store.tests.every((t) => t.confirmed === false), '导入记录均为待对账（confirmed=false）');
  assert(store.tests.every((t) => t.source === 'timegrapher'), '导入记录来源为校表仪');

  // 2. 重试同批：全部跳过，不重复新增
  result = await store.importBatch(batch);
  assertEq(result.imported, 0, '重试同批新增 0 条（幂等）');
  assertEq(result.skipped, 2, '重试同批跳过 2 条');
  assertEq(store.tests.length, 2, '重试后库中仍 2 条，无重复');

  // 3. 模拟失败：第 1 条写入后报错
  await db.tests.clear(); store.tests = [];
  const batch2: ImportBatch = {
    batchId: 'BATCH-TEST-002',
    source: 'paper',
    records: [
      mkDraft('clk1', 'CLK-002', testedAt, 5.0),
      mkDraft('clk1', 'CLK-002', testedAt + 1000, 6.0),
    ],
  };
  result = await store.importBatch(batch2, true);
  assertEq(result.failed, true, '模拟失败返回 failed=true');
  assertEq(result.imported, 1, '失败前已写入 1 条');
  assertEq(store.tests.length, 1, '失败后库中 1 条');

  // 4. 失败后重试：已写入的跳过，剩余继续写入，最终无重复
  result = await store.importBatch(batch2, true);
  assertEq(result.skipped, 1, '重试跳过已写入的 1 条');
  assertEq(result.imported, 1, '重试又写入 1 条');
  assertEq(result.failed, true, '重试仍模拟失败（checkbox 未取消）');
  assertEq(store.tests.length, 2, '重试后库中 2 条，无重复');

  // 5. 取消模拟后重试：全部跳过（已全部写入）
  result = await store.importBatch(batch2, false);
  assertEq(result.imported, 0, '取消模拟后重试新增 0 条');
  assertEq(result.skipped, 2, '取消模拟后重试跳过 2 条');
  assertEq(store.tests.length, 2, '最终库中 2 条，无重复');

  // 6. 确认采用：重算均值与结论
  await db.tests.clear(); store.tests = [];
  const archive: TimekeepingTestDraft = {
    clockId: 'clk1', clockNo: 'CLK-001', testedAt,
    amplitude: 262, beatError: 0.4, rate: 6.5, powerReserve: 46, conclusion: '合格',
    positions: [
      { position: '面上', rate: 5.2, amplitude: 268, beatError: 0.3 },
      { position: '面下', rate: 7.8, amplitude: 256, beatError: 0.5 },
      { position: '12上', rate: 6.1, amplitude: 262, beatError: 0.4 },
      { position: '6上', rate: 6.9, amplitude: 258, beatError: 0.4 },
    ],
  };
  const archiveRecord = await store.addTest({ ...archive, source: 'manual', confirmed: true });
  const candBatch: ImportBatch = {
    batchId: 'BATCH-CONFIRM',
    source: 'timegrapher',
    records: [mkDraft('clk1', 'CLK-001', testedAt, 5.0)],
  };
  await store.importBatch(candBatch);
  const candidate = store.tests.find((t) => t.batchId === 'BATCH-CONFIRM')!;
  assert(candidate.confirmed === false, '候选为待对账');

  // 采用候选的方位读数
  const adopted: PositionReading[] = [
    { position: '面上', rate: 5.0, amplitude: 260, beatError: 0.4 },
    { position: '面下', rate: 6.0, amplitude: 258, beatError: 0.5 },
    { position: '12上', rate: 5.5, amplitude: 262, beatError: 0.4 },
    { position: '6上', rate: 5.8, amplitude: 256, beatError: 0.4 },
  ];
  await store.confirmTest(candidate.id, adopted);

  const updated = store.tests.find((t) => t.id === archiveRecord.id)!;
  assertEq(updated.confirmed, true, '归档记录仍为已确认');
  assertEq(updated.rate, 5.58, '确认后重算日差均值 = 5.58');
  assertEq(updated.amplitude, 259, '确认后重算摆幅均值 = 259');
  assertEq(updated.beatError, 0.43, '确认后重算偏振均值 = 0.43');
  assertEq(updated.positions.length, 4, '归档方位读数为采用的 4 条');
  assert(store.tests.find((t) => t.id === candidate.id) === undefined, '候选已清理');
  assertEq(store.tests.length, 1, '确认后仅余 1 条归档');

  // 7. 详情页只显示已确认
  const confirmed = store.confirmedByClock('clk1');
  assertEq(confirmed.length, 1, '详情页历史只显示已确认结果');
  assertEq(confirmed[0].id, archiveRecord.id, '详情页历史为归档记录');

  // 8. 旧数据（无 confirmed 字段）继续按原结论展示
  await db.tests.clear(); store.tests = [];
  const legacy = await store.addTest({ ...archive, conclusion: '合格' });
  // 模拟旧数据：移除 confirmed 字段
  await db.tests.update(legacy.id, { confirmed: undefined as any });
  const legacyList = store.confirmedByClock('clk1');
  assertEq(legacyList.length, 1, '旧数据仍显示在详情页');
  assertEq(legacyList[0].conclusion, '合格', '旧数据按原结论展示');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
