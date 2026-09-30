<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { useStepStore } from '../stores/stepStore';
import { useTestImportStore } from '../stores/testImportStore';
import RateChart from '../components/common/RateChart.vue';
import StateBadge from '../components/common/StateBadge.vue';
import ReconcileDialog from '../components/common/ReconcileDialog.vue';
import { TEST_SOURCE_LABELS, TEST_POSITIONS, judgeTest, type PositionReading } from '../types/test';
import type { ReconcileGroup } from '../utils/reconcile';
import {
  amplitudeLevel,
  avgAmplitude,
  avgBeatError,
  avgRate,
  beatErrorLevel,
  rateLabel,
  ratePerDayToMonth,
} from '../utils/timeCalc';

const route = useRoute();
const router = useRouter();
const clockStore = useClockStore();
const stepStore = useStepStore();
const importStore = useTestImportStore();

const clockId = ref(String(route.params.clockId ?? ''));
const clock = computed(() => clockStore.byId(clockId.value));
const tests = computed(() => stepStore.testsByClock(clockId.value));
const pendingGroups = computed(() => importStore.groupsForClock(clockId.value));

const readings = reactive<PositionReading[]>(
  TEST_POSITIONS.map((position) => ({ position, rate: 0, amplitude: 260, beatError: 0.4 })),
);
const powerReserve = ref(42);
const customConclusion = ref('');

// 双源导入
const importVisible = ref(false);
const machineText = ref('');
const paperText = ref('');
const importing = ref(false);
const lastImportSummary = ref('');

// 对账弹窗
const activeGroup = ref<ReconcileGroup | null>(null);

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
    testedAt: Date.now(),
    amplitude: avg.value.amplitude,
    beatError: avg.value.beatError,
    rate: avg.value.rate,
    positions: readings.map((r) => ({ ...r })),
    powerReserve: powerReserve.value,
    conclusion: conclusion.value,
    status: 'confirmed',
    source: 'manual',
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

/** 填充一份示范导入文本：同一轮测试，刻意制造缺方位与超差供对账演示 */
function fillSample() {
  const clockNo = clock.value?.clockNo ?? 'CLK-0000-000';
  const t = new Date();
  const iso = new Date(t.getTime() - (t.getSeconds() * 1000 + t.getMilliseconds())).toISOString();
  machineText.value = JSON.stringify(
    [
      {
        clockNo,
        testedAt: iso,
        powerReserve: 44,
        positions: [
          { position: '面上', rate: 4.1, amplitude: 271, beatError: 0.3 },
          { position: '面下', rate: 6.4, amplitude: 260, beatError: 0.4 },
          { position: '12上', rate: 3.8, amplitude: 266, beatError: 0.3 },
          { position: '6上', rate: 5.5, amplitude: 262, beatError: 0.4 },
        ],
      },
    ],
    null,
    2,
  );
  paperText.value = JSON.stringify(
    [
      {
        clockNo,
        testedAt: new Date(new Date(iso).getTime() + 40 * 1000).toISOString(),
        powerReserve: 42,
        conclusion: '可用（需再调）',
        positions: [
          { position: '面上', rate: 4.1, amplitude: 271, beatError: 0.3 },
          { position: '12上', rate: 5.9, amplitude: 264, beatError: 0.3 },
          { position: '6上', rate: 5.5, amplitude: 262, beatError: 1.0 },
        ],
      },
    ],
    null,
    2,
  );
  lastImportSummary.value = '';
}

async function submitImport() {
  importing.value = true;
  try {
    const result = await importStore.importBatch(machineText.value, paperText.value, clockStore.items);
    if (!result.ok && result.errors.length > 0) {
      lastImportSummary.value = `导入失败，未写入任何数据，可修改后重试：\n${result.errors.join('\n')}`;
      ElMessage.error('导入失败，请按提示修改后重试（不会重复新增）');
      return;
    }
    const parts: string[] = [];
    parts.push(`新增 ${result.added} 行`);
    if (result.skipped > 0) parts.push(`跳过重复 ${result.skipped} 行`);
    if (result.batchReplayed) parts.push('检测到同一批次重试，未重复新增');
    lastImportSummary.value = `导入完成：${parts.join('，')}。`;
    ElMessage.success(lastImportSummary.value);
  } finally {
    importing.value = false;
  }
}

function openReconcile(group: ReconcileGroup) {
  activeGroup.value = group;
}

async function discardGroup(group: ReconcileGroup) {
  try {
    await ElMessageBox.confirm('放弃后不生成正式记录，原始导入仍保留用于去重。确定放弃该组对账？', '放弃对账', {
      type: 'warning',
    });
  } catch {
    return;
  }
  await importStore.discardGroup(group);
  ElMessage.success('已放弃该组对账');
}

function groupClockNo(clockIdOfGroup: string): string {
  return clockStore.byId(clockIdOfGroup)?.clockNo ?? '未知藏品号';
}

onMounted(async () => {
  await clockStore.load();
  await stepStore.load();
  await importStore.load();
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
      <el-tag v-if="pendingGroups.length" type="warning">待对账 {{ pendingGroups.length }} 组</el-tag>
      <div class="spacer" />
      <el-button @click="router.push(`/clocks/${clockId}`)">返回钟表详情</el-button>
    </div>

    <!-- 双源导入与对账 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-head">
          <strong>校表仪 / 纸单双源对账</strong>
          <span class="muted hint">
            按藏品号 + 测试时间（分钟）配对；缺方位、日差相差超过 1 s/d 或偏振相差超过 0.5 ms 时保留两值供选择
          </span>
          <div class="spacer" />
          <el-button size="small" @click="fillSample">填入示范文本</el-button>
          <el-button size="small" type="primary" @click="importVisible = true">导入双源结果</el-button>
        </div>
      </template>

      <el-table :data="pendingGroups" size="small" border>
        <el-table-column label="测试时间（分钟）" min-width="170">
          <template #default="{ row }">{{ new Date(row.testedAt).toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column label="校表仪" width="80">
          <template #default="{ row }">
            <StateBadge v-if="row.machine" label="有" tone="success" />
            <StateBadge v-else label="缺" tone="warning" />
          </template>
        </el-table-column>
        <el-table-column label="纸单" width="80">
          <template #default="{ row }">
            <StateBadge v-if="row.paper" label="有" tone="success" />
            <StateBadge v-else label="缺" tone="warning" />
          </template>
        </el-table-column>
        <el-table-column label="缺方位" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.missingCount" type="warning" size="small">{{ row.missingCount }} 处</el-tag>
            <span v-else class="muted">无</span>
          </template>
        </el-table-column>
        <el-table-column label="数值超差" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.conflictCount" type="danger" size="small">{{ row.conflictCount }} 处</el-tag>
            <span v-else class="muted">无</span>
          </template>
        </el-table-column>
        <el-table-column label="纸单原结论" min-width="120" prop="paperConclusion">
          <template #default="{ row }">{{ row.paperConclusion || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170">
          <template #default="{ row }">
            <el-button size="small" type="primary" @click="openReconcile(row)">对账确认</el-button>
            <el-button size="small" @click="discardGroup(row)">放弃</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="pendingGroups.length === 0" description="暂无待对账的双源结果" :image-size="60" />
    </el-card>

    <div class="grid">
      <el-card shadow="never">
        <template #header><strong>多方位读数录入（手工）</strong></template>
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

      <div class="right">
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
      </div>
    </div>

    <el-card shadow="never">
      <template #header><strong>历史测试记录（仅已确认结果）</strong></template>
      <el-table :data="tests" size="small" border>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ new Date(row.testedAt).toLocaleString('zh-CN') }}</template>
        </el-table-column>
        <el-table-column label="来源" width="100">
          <template #default="{ row }">
            <StateBadge
              :label="row.source ? TEST_SOURCE_LABELS[row.source as keyof typeof TEST_SOURCE_LABELS] : '历史记录'"
              :tone="row.source === 'mixed' ? 'primary' : row.source === 'machine' ? 'success' : row.source === 'paper' ? 'warning' : 'info'"
            />
          </template>
        </el-table-column>
        <el-table-column prop="rate" label="日差" width="80" />
        <el-table-column prop="amplitude" label="摆幅" width="80" />
        <el-table-column prop="beatError" label="偏振" width="80" />
        <el-table-column prop="powerReserve" label="动储 h" width="90" />
        <el-table-column prop="conclusion" label="结论" min-width="120" />
      </el-table>
      <el-empty v-if="tests.length === 0" description="暂无历史测试" :image-size="60" />
    </el-card>

    <!-- 导入对话框 -->
    <el-dialog v-model="importVisible" title="导入校表仪 / 纸单结果" width="760px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="两栏均粘贴 JSON 数组，按藏品号 clockNo + 测试时间 testedAt（同分钟即视为同一轮）配对。任一行不合规则整批失败，可修改后原样重试，重试不重复新增。"
        style="margin-bottom: 12px"
      />
      <el-row :gutter="12">
        <el-col :span="12">
          <div class="import-label">校表仪导出（JSON 数组）</div>
          <el-input v-model="machineText" type="textarea" :rows="14" placeholder='[{"clockNo":"CLK-1932-004","testedAt":"2026-09-30T10:00:00.000Z","powerReserve":44,"positions":[{"position":"面上","rate":4.1,"amplitude":271,"beatError":0.3}]}]' />
        </el-col>
        <el-col :span="12">
          <div class="import-label">纸单抄录（JSON 数组，方位可缺）</div>
          <el-input v-model="paperText" type="textarea" :rows="14" placeholder='[{"clockNo":"CLK-1932-004","testedAt":"2026-09-30T10:00:40.000Z","powerReserve":42,"conclusion":"可用（需再调）","positions":[{"position":"面上","rate":4.1,"amplitude":271,"beatError":0.3}]}]' />
        </el-col>
      </el-row>
      <el-alert
        v-if="lastImportSummary"
        class="import-summary"
        :type="lastImportSummary.startsWith('导入失败') ? 'error' : 'success'"
        :closable="false"
        show-icon
        :title="lastImportSummary"
      />
      <template #footer>
        <el-button @click="importVisible = false">关闭</el-button>
        <el-button @click="fillSample">填入示范文本</el-button>
        <el-button type="primary" :loading="importing" @click="submitImport">导入并对账</el-button>
      </template>
    </el-dialog>

    <!-- 对账确认弹窗 -->
    <ReconcileDialog
      :group="activeGroup"
      :clock-no="activeGroup ? groupClockNo(activeGroup.clockId) : ''"
      @close="activeGroup = null"
      @confirmed="activeGroup = null"
    />
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
.right {
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
  gap: 10px;
  flex-wrap: wrap;
}
.hint {
  font-weight: normal;
}
.import-label {
  font-size: 13px;
  color: #4a5461;
  margin-bottom: 6px;
  font-weight: 600;
}
.import-summary {
  margin-top: 12px;
  white-space: pre-wrap;
}
:deep(.el-alert__title) {
  white-space: pre-wrap;
}
</style>
