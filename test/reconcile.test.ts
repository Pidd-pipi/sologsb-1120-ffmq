// 对账逻辑测试：验证 detectPositionConflict / buildPositionDiffs / buildAdoptedPositions / recalcAggregates / isConfirmed
import {
  detectPositionConflict,
  isConfirmed,
  type PositionReading,
  type TimekeepingTest,
} from '../frontend/src/types/test';
import {
  buildAdoptedPositions,
  buildPositionDiffs,
  groupKeyOf,
  recalcAggregates,
  referenceOf,
  buildReconciliationGroups,
  type ReconciliationGroup,
} from '../frontend/src/utils/reconcile';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`❌ FAIL: ${msg}`);
  }
}
function assertEq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.error(`❌ FAIL: ${msg}\n  expected: ${e}\n  actual:   ${a}`);
  }
}

// ---- detectPositionConflict ----
const r1: PositionReading = { position: '面上', rate: 5.0, amplitude: 260, beatError: 0.4 };
const r2: PositionReading = { position: '面上', rate: 5.5, amplitude: 262, beatError: 0.4 };
const r3: PositionReading = { position: '面上', rate: 6.5, amplitude: 260, beatError: 0.4 }; // rate diff 1.5 > 1
const r4: PositionReading = { position: '面上', rate: 5.0, amplitude: 260, beatError: 1.0 }; // beat diff 0.6 > 0.5

assertEq(detectPositionConflict(r1, r2), { position: '面上', missing: false, rateConflict: false, beatErrorConflict: false }, '无冲突（rate diff 0.5, beat diff 0）');
assertEq(detectPositionConflict(r1, r3), { position: '面上', missing: false, rateConflict: true, beatErrorConflict: false }, '日差相差 1.5 > 1 → 冲突');
assertEq(detectPositionConflict(r1, r4), { position: '面上', missing: false, rateConflict: false, beatErrorConflict: true }, '偏振相差 0.6 > 0.5 → 冲突');
assertEq(detectPositionConflict(r1, undefined), { position: '面上', missing: true, rateConflict: false, beatErrorConflict: false }, '缺方位（参照无值）');
assertEq(detectPositionConflict(undefined, r2), { position: '面上', missing: true, rateConflict: false, beatErrorConflict: false }, '缺方位（候选无值）');

// 边界：rate diff 恰好 1.0 不算冲突（> 1 才冲突）
const rEdge: PositionReading = { position: '面上', rate: 6.0, amplitude: 260, beatError: 0.4 };
assertEq(detectPositionConflict(r1, rEdge), { position: '面上', missing: false, rateConflict: false, beatErrorConflict: false }, '日差相差恰好 1.0 不冲突');
// 边界：beat diff 恰好 0.5 不算冲突
const rEdgeBeat: PositionReading = { position: '面上', rate: 5.0, amplitude: 260, beatError: 0.9 };
assertEq(detectPositionConflict(r1, rEdgeBeat), { position: '面上', missing: false, rateConflict: false, beatErrorConflict: false }, '偏振相差恰好 0.5 不冲突');

// ---- isConfirmed ----
assert(isConfirmed({ confirmed: true } as TimekeepingTest), 'confirmed=true → 已确认');
assert(!isConfirmed({ confirmed: false } as TimekeepingTest), 'confirmed=false → 未确认');
assert(isConfirmed({} as TimekeepingTest), '旧数据无 confirmed 字段 → 视为已确认');

// ---- groupKeyOf ----
assertEq(groupKeyOf({ clockNo: 'CLK-001', testedAt: 1000 } as TimekeepingTest), 'CLK-001__1000', '分组键 = 藏品号__测试时间');

// ---- buildPositionDiffs ----
const candidate: TimekeepingTest = {
  id: 'c1', clockId: 'clk1', clockNo: 'CLK-001', testedAt: 1000,
  amplitude: 0, beatError: 0, rate: 0, powerReserve: 0, conclusion: '',
  positions: [
    { position: '面上', rate: 5.0, amplitude: 260, beatError: 0.4 },
    { position: '面下', rate: 8.9, amplitude: 256, beatError: 0.5 }, // 与参照 rate diff 1.1 > 1
    { position: '12上', rate: 6.1, amplitude: 262, beatError: 0.4 },
  ],
};
const reference: TimekeepingTest = {
  id: 'r1', clockId: 'clk1', clockNo: 'CLK-001', testedAt: 1000,
  amplitude: 0, beatError: 0, rate: 0, powerReserve: 0, conclusion: '',
  positions: [
    { position: '面上', rate: 5.0, amplitude: 260, beatError: 0.4 },
    { position: '面下', rate: 7.8, amplitude: 256, beatError: 0.5 },
    { position: '6上', rate: 6.9, amplitude: 258, beatError: 0.4 }, // 候选缺 6上
  ],
};
const rows = buildPositionDiffs(candidate, reference);
assertEq(rows.length, 4, '对账行数量 = 4（3 候选 + 1 参照独有）');
const shangMian = rows.find((r) => r.position === '面上')!;
assert(!shangMian.needChoice, '面上无冲突 → 不需选择');
const xiaMian = rows.find((r) => r.position === '面下')!;
assert(xiaMian.needChoice && xiaMian.conflict.rateConflict, '面下日差冲突 → 需选择');
const shiEr = rows.find((r) => r.position === '12上')!;
assert(shiEr.conflict.missing && shiEr.candidate && !shiEr.reference, '12上缺方位（仅候选有）');
const liu = rows.find((r) => r.position === '6上')!;
assert(liu.conflict.missing && !liu.candidate && liu.reference, '6上缺方位（仅参照有）');

// ---- buildAdoptedPositions ----
// 选择：面下采用候选，其余默认
const adopted = buildAdoptedPositions(candidate, reference, { 面下: 'candidate' });
const adoptedXiaMian = adopted.find((p) => p.position === '面下')!;
assertEq(adoptedXiaMian.rate, 8.9, '面下采用候选值 8.9');
const adoptedLiu = adopted.find((p) => p.position === '6上')!;
assertEq(adoptedLiu.rate, 6.9, '6上缺方位 → 采用参照值 6.9');
const adoptedShiEr = adopted.find((p) => p.position === '12上')!;
assertEq(adoptedShiEr.rate, 6.1, '12上缺方位 → 采用候选值 6.1');
const adoptedShangMian = adopted.find((p) => p.position === '面上')!;
assertEq(adoptedShangMian.rate, 5.0, '面上无冲突 → 采用参照值');

// 选择面下采用参照
const adopted2 = buildAdoptedPositions(candidate, reference, { 面下: 'reference' });
assertEq(adopted2.find((p) => p.position === '面下')!.rate, 7.8, '面下采用参照值 7.8');

// ---- recalcAggregates ----
const agg = recalcAggregates([
  { position: '面上', rate: 5.0, amplitude: 260, beatError: 0.4 },
  { position: '面下', rate: 7.0, amplitude: 270, beatError: 0.6 },
]);
assertEq(agg.rate, 6, '重算日差均值 = 6');
assertEq(agg.amplitude, 265, '重算摆幅均值 = 265');
assertEq(agg.beatError, 0.5, '重算偏振均值 = 0.5');

// ---- buildReconciliationGroups ----
const archive: TimekeepingTest = {
  id: 'a1', clockId: 'clk1', clockNo: 'CLK-001', testedAt: 1000,
  amplitude: 0, beatError: 0, rate: 0, powerReserve: 0, conclusion: '合格',
  positions: [], confirmed: true, source: 'manual',
};
const cand1: TimekeepingTest = {
  id: 'c1', clockId: 'clk1', clockNo: 'CLK-001', testedAt: 1000,
  amplitude: 0, beatError: 0, rate: 0, powerReserve: 0, conclusion: '',
  positions: [], confirmed: false, source: 'timegrapher', batchId: 'B1',
};
const cand2: TimekeepingTest = {
  id: 'c2', clockId: 'clk1', clockNo: 'CLK-001', testedAt: 1000,
  amplitude: 0, beatError: 0, rate: 0, powerReserve: 0, conclusion: '',
  positions: [], confirmed: false, source: 'paper', batchId: 'B2',
};
const groups = buildReconciliationGroups([archive, cand1, cand2]);
assertEq(groups.length, 1, '三个记录同组 → 1 个对账分组');
assertEq(groups[0].archive?.id, 'a1', '分组归档 = archive');
assertEq(groups[0].candidates.length, 2, '分组候选 = 2 条');
assertEq(referenceOf(groups[0] as ReconciliationGroup, cand1)?.id, 'a1', '候选参照 = 归档记录');

// 无归档时，候选参照 = 另一条候选
const groups2 = buildReconciliationGroups([cand1, cand2]);
assertEq(groups2.length, 1, '无归档 → 1 个对账分组');
assertEq(groups2[0].archive, undefined, '无归档记录');
assertEq(referenceOf(groups2[0] as ReconciliationGroup, cand1)?.id, 'c2', '无归档时候选参照 = 另一条候选');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
