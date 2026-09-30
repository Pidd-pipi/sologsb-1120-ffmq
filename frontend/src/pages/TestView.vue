<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { useStepStore } from '../stores/stepStore';
import RateChart from '../components/common/RateChart.vue';
import StateBadge from '../components/common/StateBadge.vue';
import {
  TEST_POSITIONS,
  TEST_SOURCE_LABELS,
  judgeTest,
  sourceOf,
  isConfirmed,
  type ImportBatch,
  type PositionReading,
  type TestPosition,
  type TimekeepingTest,
  type TimekeepingTestDraft,
} from '../types/test';
import {
  amplitudeLevel,
  avgAmplitude,
  avgBeatError,
  avgRate,
  beatErrorLevel,
  rateLabel,
  ratePerDayToMonth,
} from '../utils/timeCalc';
import {
  buildAdoptedPositions,
  buildPositionDiffs,
  buildReconciliationGroups,
  recalcAggregates,
  referenceOf,
  sourceLabel,
  type AdoptSide,
  type PositionDiffRow,
} from '../utils/reconcile';

const route = useRoute();
const router = useRouter();
const clockStore = useClockStore();
const stepStore = useStepStore();

const clockId = ref(String(route.params.clockId ?? ''));
const clock = computed(() => clockStore.byId(clockId.value));
const tests = computed(() => stepStore.testsByClock(clockId.value));
const candidates = computed(() => stepStore.candidatesByClock(clockId.value));

const readings = reactive<PositionReading[]>(
  TEST_POSITIONS.map((position) => ({ position, rate: 0, amplitude: 260, beatError: 0.4 })),
);
const powerReserve = ref(42);
const customConclusion = ref('');

const avg = computed(() => ({
  rate: avgRate(readings),
  amplitude: avgAmplitude(readings),
  beatError: avgBeatError(readings),
}));

const conclusion = computed(() =>
  customConclusion.value.trim() ? customConclusion.value.trim() : judgeTest(avg.value.rate, avg.value.beatError, avg.value.amplitude),
);

const workSheet = computed(() => {
  const lines: string[] = [];
  lines.push('走时测试单');
  lines.push(`藏品号：${clock.value?.clockNo ?? '未知'}（${clock.value?.kind ?? ''} / ${clock.value?.caliber ?? ''}）`);
  lines.push(`测试时间：${new Date().toLocaleString('zh-CN')}`);
  lines.push('');
  lines.push('方位\t日差(s/d)\t摆幅(°)\t偏振(ms)');
  readings.forEach((r) => {
    lines.push(`${r.position}\t${r.rate}\t${r.amplitude}\t${r.beatError}`);
  });
  lines.push('');
  lines.push(`平均日差：${avg.value.rate} s/d（约 ${ratePerDayToMonth(avg.value.rate)} s/月，${rateLabel(avg.value.rate)}）`);
  lines.push(`平均摆幅：${avg.value.amplitude} °（${amplitudeLevel(avg.value.amplitude).label}）`);
  lines.push(`平均偏振：${avg.value.beatError} ms（${beatErrorLevel(avg.value.beatError).label}）`);
  lines.push(`动力储备：${powerReserve.value} h`);
  lines.push(`结论：${conclusion.value}`);
  return lines.join('\n');
});

async function save() {
  if (!clockId.value) {
    ElMessage.error('未指定钟表');
    return;
  }
  await stepStore.addTest({
    clockId: clockId.value,
    clockNo: clock.value?.clockNo,
    testedAt: Date.now(),
    amplitude: avg.value.amplitude,
    beatError: avg.value.beatError,
    rate: avg.value.rate,
    positions: readings.map((r) => ({ ...r })),
    powerReserve: powerReserve.value,
    conclusion: conclusion.value,
    source: 'manual',
    confirmed: true,
  });
  ElMessage.success('走时测试已记录');
}

async function copySheet() {
  try {
    await navigator.clipboard.writeText(workSheet.value);
    ElMessage.success('走时单已复制');
  } catch {
    ElMessage.warning('浏览器未授权剪贴板，请手动复制');
  }
}

function downloadSheet() {
  const blob = new Blob([workSheet.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `走时单_${clock.value?.clockNo ?? 'clock'}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success('走时单已导出');
}

function reset() {
  readings.forEach((r) => {
    r.rate = 0;
    r.amplitude = 260;
    r.beatError = 0.4;
  });
  customConclusion.value = '';
}

/* ------------------------------ 导入与对账 ------------------------------ */

const simulateFailure = ref(false);
const importState = reactive({
  loading: false,
  failed: false,
  error: '',
  batches: [] as ImportBatch[],
  lastSummary: '',
});

/** 依据藏品号补全 clockId；找不到钟表时给出警告 */
function resolveClockIds(batches: ImportBatch[]) {
  const missing: string[] = [];
  for (const batch of batches) {
    for (const record of batch.records) {
      if (!record.clockId) {
        const clockNo = record.clockNo ?? '';
        const found = clockStore.items.find((c) => c.clockNo === clockNo);
        if (found) record.clockId = found.id;
        else if (!missing.includes(clockNo)) missing.push(clockNo);
      }
    }
  }
  return missing;
}

async function runImport(batches: ImportBatch[]) {
  resolveClockIds(batches);
  importState.loading = true;
  importState.failed = false;
  const summaries: string[] = [];
  try {
    for (const batch of batches) {
      const result = await stepStore.importBatch(batch, simulateFailure.value);
      summaries.push(`${batch.batchId}：新增 ${result.imported}，跳过 ${result.skipped}`);
      if (result.failed) {
        importState.failed = true;
        importState.error = result.error;
        importState.batches = batches;
        importState.lastSummary = summaries.join('；');
        ElMessage.error('导入失败，可重试');
        return;
      }
    }
    importState.batches = [];
    importState.lastSummary = summaries.join('；');
    ElMessage.success(`导入完成（${importState.lastSummary}）`);
  } finally {
    importState.loading = false;
  }
}

async function retryImport() {
  if (importState.batches.length === 0) return;
  await runImport(importState.batches);
}

/** 载入示例对账批次：校表仪 + 纸单，与种子测试同藏品号同测试时间 */
function buildDemoBatches(): ImportBatch[] {
  const clockA = clockStore.items.find((c) => c.clockNo === 'CLK-1932-004');
  const clockB = clockStore.items.find((c) => c.clockNo === 'CLK-1890-011');
  const day = 24 * 3600 * 1000;
  const seedTest = stepStore.tests.find((t) => t.clockId === clockA?.id && isConfirmed(t));
  const testedAtA = seedTest ? seedTest.testedAt : Date.now() - 2 * day;
  const testedAtB = Date.now() - 3 * day;

  const mkRecord = (
    clockId: string,
    clockNo: string,
    testedAt: number,
    positions: PositionReading[],
    powerReserve: number,
  ): TimekeepingTestDraft => {
    const { rate, amplitude, beatError } = recalcAggregates(positions);
    return {
      clockId,
      clockNo,
      testedAt,
      positions,
      rate,
      amplitude,
      beatError,
      powerReserve,
      conclusion: judgeTest(rate, beatError, amplitude),
    };
  };

  const tgRecords: TimekeepingTestDraft[] = [];
  const paperRecords: TimekeepingTestDraft[] = [];
  if (clockA) {
    tgRecords.push(
      mkRecord(clockA.id, clockA.clockNo, testedAtA, [
        { position: '面上', rate: 5.2, amplitude: 268, beatError: 0.3 },
        { position: '面下', rate: 8.9, amplitude: 256, beatError: 0.5 },
        { position: '12上', rate: 6.1, amplitude: 262, beatError: 0.4 },
        { position: '6上', rate: 6.9, amplitude: 258, beatError: 0.4 },
      ], 46),
    );
    paperRecords.push(
      mkRecord(clockA.id, clockA.clockNo, testedAtA, [
        { position: '面上', rate: 5.2, amplitude: 268, beatError: 0.3 },
        { position: '面下', rate: 7.8, amplitude: 256, beatError: 0.5 },
        { position: '6上', rate: 6.9, amplitude: 258, beatError: 1.0 },
      ], 46),
    );
  }
  if (clockB) {
    tgRecords.push(
      mkRecord(clockB.id, clockB.clockNo, testedAtB, [
        { position: '面上', rate: 4.0, amplitude: 270, beatError: 0.3 },
        { position: '面下', rate: 6.2, amplitude: 260, beatError: 0.5 },
        { position: '12上', rate: 5.5, amplitude: 265, beatError: 0.4 },
        { position: '6上', rate: 7.1, amplitude: 258, beatError: 0.4 },
      ], 40),
    );
    paperRecords.push(
      mkRecord(clockB.id, clockB.clockNo, testedAtB, [
        { position: '面上', rate: 4.0, amplitude: 270, beatError: 0.3 },
        { position: '面下', rate: 6.2, amplitude: 260, beatError: 0.5 },
        { position: '12上', rate: 5.5, amplitude: 265, beatError: 0.4 },
        { position: '6上', rate: 8.5, amplitude: 258, beatError: 1.1 },
      ], 40),
    );
  }

  return [
    { batchId: 'BATCH-TG-DEMO', source: 'timegrapher', records: tgRecords },
    { batchId: 'BATCH-PAPER-DEMO', source: 'paper', records: paperRecords },
  ];
}

async function loadDemoBatches() {
  const batches = buildDemoBatches();
  if (batches.every((b) => b.records.length === 0)) {
    ElMessage.warning('未找到示例钟表，请先在台账中创建');
    return;
  }
  await runImport(batches);
}

/** 归一化导入文件为批次 */
function normalizeBatch(data: unknown): ImportBatch {
  if (!data || typeof data !== 'object' || !Array.isArray((data as any).records)) {
    throw new Error('文件缺少 records 数组');
  }
  const raw = data as Record<string, unknown>;
  const source = raw.source === 'paper' ? 'paper' : 'timegrapher';
  const batchId = typeof raw.batchId === 'string' && raw.batchId ? raw.batchId : `BATCH-${Date.now()}`;
  const records = (raw.records as unknown[]).map((item) => {
    const r = item as Record<string, unknown>;
    if (!r.clockNo) throw new Error('记录缺少 clockNo（藏品号）');
    if (!r.testedAt) throw new Error('记录缺少 testedAt（测试时间）');
    const positions: PositionReading[] = Array.isArray(r.positions)
      ? (r.positions as PositionReading[])
      : [];
    const { rate, amplitude, beatError } = recalcAggregates(positions);
    return {
      clockId: '',
      clockNo: String(r.clockNo),
      testedAt: Number(r.testedAt),
      positions,
      rate: typeof r.rate === 'number' ? r.rate : rate,
      amplitude: typeof r.amplitude === 'number' ? r.amplitude : amplitude,
      beatError: typeof r.beatError === 'number' ? r.beatError : beatError,
      powerReserve: typeof r.powerReserve === 'number' ? r.powerReserve : 0,
      conclusion: typeof r.conclusion === 'string' ? r.conclusion : '',
    } as TimekeepingTestDraft;
  });
  return { batchId, source, records };
}

const fileInput = ref<HTMLInputElement | null>(null);
async function onFileUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const batch = normalizeBatch(JSON.parse(text));
    await runImport([batch]);
  } catch (e) {
    ElMessage.error(`导入文件解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  input.value = '';
}

/* ------------------------------ 对账面板 ------------------------------ */

interface ReconcileCard {
  candidate: TimekeepingTest;
  reference: TimekeepingTest | undefined;
  rows: PositionDiffRow[];
}

const reconcileCards = computed<ReconcileCard[]>(() => {
  const groups = buildReconciliationGroups(stepStore.tests).filter((g) =>
    g.candidates.some((c) => c.clockId === clockId.value),
  );
  const cards: ReconcileCard[] = [];
  for (const group of groups) {
    for (const candidate of group.candidates) {
      if (candidate.clockId !== clockId.value) continue;
      const reference = referenceOf(group, candidate);
      const rows = buildPositionDiffs(candidate, reference);
      cards.push({ candidate, reference, rows });
    }
  }
  return cards;
});

/** 各候选的方位选择：candidate / reference */
const choicesMap = reactive<Record<string, Partial<Record<TestPosition, AdoptSide>>>>({});

watch(
  reconcileCards,
  (cards) => {
    for (const card of cards) {
      if (!choicesMap[card.candidate.id]) {
        const init: Partial<Record<TestPosition, AdoptSide>> = {};
        for (const row of card.rows) {
          if (row.needChoice && !row.conflict.missing) init[row.position] = 'candidate';
        }
        choicesMap[card.candidate.id] = init;
      }
    }
  },
  { immediate: true },
);

function choicesOf(candidateId: string): Partial<Record<TestPosition, AdoptSide>> {
  return choicesMap[candidateId] ?? {};
}

function getChoice(candidateId: string, position: unknown): AdoptSide {
  const pos = position as TestPosition;
  return choicesOf(candidateId)[pos] ?? 'candidate';
}

function setChoice(candidateId: string, position: unknown, side: AdoptSide) {
  const pos = position as TestPosition;
  choicesOf(candidateId)[pos] = side;
}

function adoptAll(card: ReconcileCard, side: AdoptSide) {
  const choices = choicesOf(card.candidate.id);
  for (const row of card.rows) {
    if (row.needChoice && !row.conflict.missing) choices[row.position] = side;
  }
}

async function confirmCard(card: ReconcileCard) {
  const adopted = buildAdoptedPositions(card.candidate, card.reference, choicesOf(card.candidate.id));
  await stepStore.confirmTest(card.candidate.id, adopted);
  ElMessage.success('已确认采用，均值与结论已重算');
}

async function rejectCard(card: ReconcileCard) {
  await stepStore.rejectTest(card.candidate.id);
  ElMessage.warning('已丢弃该候选结果');
}

function diffText(row: PositionDiffRow): string {
  if (row.conflict.missing) return '缺方位';
  const parts: string[] = [];
  if (row.conflict.rateConflict && row.candidate && row.reference) {
    parts.push(`日差相差 ${Math.abs(row.candidate.rate - row.reference.rate).toFixed(1)} s/d`);
  }
  if (row.conflict.beatErrorConflict && row.candidate && row.reference) {
    parts.push(`偏振相差 ${Math.abs(row.candidate.beatError - row.reference.beatError).toFixed(1)} ms`);
  }
  return parts.join('，');
}

onMounted(async () => {
  await clockStore.load();
  await stepStore.load();
  if (!clock.value && clockStore.items.length > 0) {
    clockId.value = clockStore.items[0].id;
    await router.replace(`/tests/${clockId.value}`);
  }
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>走时测试 · {{ clock?.clockNo ?? '未选择' }}</h2>
      <StateBadge :grade="clock?.conditionGrade" />
      <el-tag type="info" effect="plain">历史测试 {{ tests.length }} 次</el-tag>
      <el-tag v-if="candidates.length" type="warning" effect="plain">待对账 {{ candidates.length }} 条</el-tag>
      <div class="spacer" />
      <el-button @click="router.push(`/clocks/${clockId}`)">返回钟表详情</el-button>
    </div>

    <div class="grid">
      <div class="col">
        <el-card shadow="never">
          <template #header><strong>多方位读数录入</strong></template>
          <el-table :data="readings" size="small" border>
            <el-table-column prop="position" label="方位" width="90" />
            <el-table-column label="日差 s/d" width="150">
              <template #default="{ row }">
                <el-input-number v-model="row.rate" :min="-99" :max="99" :step="0.1" :precision="1" size="small" />
              </template>
            </el-table-column>
            <el-table-column label="摆幅 °" width="160">
              <template #default="{ row }">
                <el-input-number v-model="row.amplitude" :min="0" :max="400" :step="1" size="small" />
              </template>
            </el-table-column>
            <el-table-column label="偏振 ms" width="160">
              <template #default="{ row }">
                <el-input-number v-model="row.beatError" :min="0" :max="9.9" :step="0.1" :precision="1" size="small" />
              </template>
            </el-table-column>
            <el-table-column label="分级" min-width="140">
              <template #default="{ row }">
                <StateBadge :label="amplitudeLevel(row.amplitude).label" :tone="amplitudeLevel(row.amplitude).type" />
                <StateBadge :label="beatErrorLevel(row.beatError).label" :tone="beatErrorLevel(row.beatError).type" />
              </template>
            </el-table-column>
          </el-table>

          <el-form label-width="110px" style="margin-top: 14px">
            <el-form-item label="动力储备 h">
              <el-input-number v-model="powerReserve" :min="0" :max="400" />
            </el-form-item>
            <el-form-item label="结论（可选）">
              <el-input v-model="customConclusion" placeholder="留空则按均值自动判定" />
            </el-form-item>
            <el-form-item>
              <el-button type="primary" @click="save">保存测试记录</el-button>
              <el-button @click="reset">重置读数</el-button>
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>导入与对账</strong></template>
          <div class="import-row">
            <el-button type="primary" @click="fileInput?.click()">导入走时文件（JSON）</el-button>
            <el-button @click="loadDemoBatches" :loading="importState.loading">载入示例批次</el-button>
            <input
              ref="fileInput"
              type="file"
              accept=".json,application/json"
              style="display: none"
              @change="onFileUpload"
            />
            <el-checkbox v-model="simulateFailure">模拟导入失败（验证重试不重复）</el-checkbox>
          </div>
          <el-alert
            v-if="importState.failed"
            type="error"
            :closable="false"
            show-icon
            style="margin-top: 10px"
            :title="`导入失败：${importState.error}`"
          >
            <div class="retry-row">
              <el-button size="small" type="primary" @click="retryImport" :loading="importState.loading">重试导入</el-button>
              <span class="muted">重试同批将跳过已存在记录，不会重复新增</span>
            </div>
          </el-alert>
          <el-alert
            v-else-if="importState.lastSummary"
            type="success"
            :closable="false"
            show-icon
            style="margin-top: 10px"
            :title="`最近导入：${importState.lastSummary}`"
          />
          <p class="muted import-hint">
            按「藏品号 + 测试时间」对账：缺方位、同一方位日差相差超过 1 s/d 或偏振相差超过 0.5 ms 时，保留两值供选择。
          </p>
        </el-card>
      </div>

      <div class="col">
        <el-card shadow="never">
          <template #header><strong>多方位均值</strong></template>
          <div class="stats">
            <div><span class="muted">平均日差</span><strong>{{ avg.rate }}</strong> s/d</div>
            <div><span class="muted">折算</span><strong>{{ ratePerDayToMonth(avg.rate) }}</strong> s/月</div>
            <div><span class="muted">平均摆幅</span><strong>{{ avg.amplitude }}</strong> °</div>
            <div><span class="muted">平均偏振</span><strong>{{ avg.beatError }}</strong> ms</div>
          </div>
          <el-alert
            :title="`判定结论：${conclusion}（${rateLabel(avg.rate)}）`"
            :type="conclusion === '合格' ? 'success' : conclusion === '不合格' ? 'error' : 'warning'"
            :closable="false"
            show-icon
          />
          <RateChart :readings="readings" />
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <strong>走时单</strong>
              <div class="spacer" />
              <el-button size="small" @click="copySheet">复制</el-button>
              <el-button size="small" type="primary" @click="downloadSheet">导出</el-button>
            </div>
          </template>
          <el-input v-model="workSheet" type="textarea" :rows="12" readonly />
        </el-card>

        <el-card shadow="never">
          <template #header><strong>历史测试记录</strong></template>
          <el-table :data="tests" size="small" border>
            <el-table-column label="时间" width="170">
              <template #default="{ row }">{{ new Date(row.testedAt).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="来源" width="90">
              <template #default="{ row }">{{ TEST_SOURCE_LABELS[sourceOf(row)] }}</template>
            </el-table-column>
            <el-table-column prop="rate" label="日差" width="80" />
            <el-table-column prop="amplitude" label="摆幅" width="80" />
            <el-table-column prop="beatError" label="偏振" width="80" />
            <el-table-column prop="powerReserve" label="动储 h" width="80" />
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag v-if="isConfirmed(row)" type="success" size="small">已确认</el-tag>
                <el-tag v-else type="warning" size="small">待对账</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="conclusion" label="结论" min-width="120" />
          </el-table>
          <el-empty v-if="tests.length === 0" description="暂无历史测试" :image-size="60" />
        </el-card>
      </div>
    </div>

    <el-card v-if="reconcileCards.length" shadow="never" class="reconcile-card">
      <template #header>
        <div class="card-head">
          <strong>待对账走时结果（{{ reconcileCards.length }}）</strong>
          <span class="muted">缺方位 / 日差 &gt; 1 s/d / 偏振 &gt; 0.5 ms 时保留两值供选择</span>
        </div>
      </template>

      <div v-for="card in reconcileCards" :key="card.candidate.id" class="reconcile-block">
        <div class="card-head">
          <el-tag size="small" type="warning">{{ sourceLabel(card.candidate) }}</el-tag>
          <strong>{{ new Date(card.candidate.testedAt).toLocaleString('zh-CN') }}</strong>
          <span class="muted">批次 {{ card.candidate.batchId }}</span>
          <span class="muted">
            日差 {{ card.candidate.rate }} · 摆幅 {{ card.candidate.amplitude }} · 偏振 {{ card.candidate.beatError }}
          </span>
          <div class="spacer" />
          <el-button size="small" @click="adoptAll(card, 'candidate')">全部采用{{ sourceLabel(card.candidate) }}</el-button>
          <el-button size="small" @click="adoptAll(card, 'reference')" :disabled="!card.reference">
            全部采用{{ sourceLabel(card.reference) }}
          </el-button>
          <el-button size="small" type="primary" @click="confirmCard(card)">确认采用</el-button>
          <el-button size="small" type="danger" plain @click="rejectCard(card)">丢弃</el-button>
        </div>

        <el-table :data="card.rows" size="small" border class="diff-table">
          <el-table-column prop="position" label="方位" width="80" />
          <el-table-column :label="sourceLabel(card.candidate)" min-width="200">
            <template #default="{ row }">
              <span v-if="row.candidate">
                日差 {{ row.candidate.rate }} · 摆幅 {{ row.candidate.amplitude }} · 偏振 {{ row.candidate.beatError }}
              </span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column :label="sourceLabel(card.reference)" min-width="200">
            <template #default="{ row }">
              <span v-if="row.reference">
                日差 {{ row.reference.rate }} · 摆幅 {{ row.reference.amplitude }} · 偏振 {{ row.reference.beatError }}
              </span>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="对账" min-width="180">
            <template #default="{ row }">
              <el-tag v-if="!row.needChoice" type="success" size="small">一致</el-tag>
              <el-tag v-else-if="row.conflict.missing" type="warning" size="small">缺方位</el-tag>
              <span v-else class="conflict-text">{{ diffText(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="采用" width="220">
            <template #default="{ row }">
              <el-radio-group
                v-if="row.needChoice && !row.conflict.missing"
                :model-value="getChoice(card.candidate.id, row.position)"
                size="small"
                @update:model-value="(v: unknown) => setChoice(card.candidate.id, row.position, v as AdoptSide)"
              >
                <el-radio-button value="candidate">{{ sourceLabel(card.candidate) }}</el-radio-button>
                <el-radio-button value="reference" :disabled="!row.reference">
                  {{ sourceLabel(card.reference) }}
                </el-radio-button>
              </el-radio-group>
              <span v-else class="muted">
                {{ row.conflict.missing ? '仅有值一方' : '—' }}
              </span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 620px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 14px;
}
.stats strong {
  font-size: 18px;
  margin: 0 4px;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.import-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.import-hint {
  margin: 10px 0 0;
}
.retry-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
}
.reconcile-card {
  margin-top: 0;
}
.reconcile-block {
  margin-bottom: 18px;
}
.diff-table {
  margin-top: 8px;
}
.conflict-text {
  color: #c45656;
  font-size: 13px;
}
</style>
