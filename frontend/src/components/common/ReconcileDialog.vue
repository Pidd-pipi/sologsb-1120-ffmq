<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import StateBadge from './StateBadge.vue';
import {
  BEAT_DIFF_TOLERANCE,
  RATE_DIFF_TOLERANCE,
  TEST_SOURCE_LABELS,
} from '../../types/test';
import {
  needsDecision,
  previewAverages,
  type PositionChoice,
  type ReconcileDecision,
  type ReconcileGroup,
} from '../../utils/reconcile';
import { useTestImportStore } from '../../stores/testImportStore';
import { useStepStore } from '../../stores/stepStore';

const props = defineProps<{
  group: ReconcileGroup | null;
  clockNo: string;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirmed'): void;
}>();

const importStore = useTestImportStore();
const stepStore = useStepStore();

const choices = ref<PositionChoice[]>([]);
const powerChoice = ref<ReconcileDecision['powerChoice']>('none');
const timeChoice = ref<ReconcileDecision['timeChoice']>('machine');
const customConclusion = ref('');
const submitting = ref(false);

watch(
  () => props.group,
  (group) => {
    if (!group) return;
    choices.value = group.choices.map((c) => ({ ...c }));
    powerChoice.value = group.powerChoice;
    timeChoice.value = group.timeChoice;
    customConclusion.value = '';
  },
  { immediate: true },
);

const decision = computed<ReconcileDecision | null>(() => {
  if (!props.group) return null;
  return {
    group: props.group,
    choices: choices.value,
    powerChoice: powerChoice.value,
    timeChoice: timeChoice.value,
    customConclusion: customConclusion.value,
  };
});

const preview = computed(() => (decision.value ? previewAverages(decision.value) : null));

const autoConclusion = computed(() => {
  if (!preview.value) return '';
  const { rate, beatError, amplitude } = preview.value;
  if (Math.abs(rate) <= 10 && beatError <= 0.8 && amplitude >= 250) return '合格';
  if (Math.abs(rate) <= 30 && beatError <= 1.2) return '可用（需再调）';
  return '不合格';
});

const machineTimeText = computed(() =>
  props.group?.machine ? new Date(props.group.machine.testedAt).toLocaleString('zh-CN') : '—',
);
const paperTimeText = computed(() =>
  props.group?.paper ? new Date(props.group.paper.testedAt).toLocaleString('zh-CN') : '—',
);

function valueText(value: number | undefined, digits = 1): string {
  return value === undefined ? '缺' : value.toFixed(digits);
}

function choiceState(choice: PositionChoice) {
  if (choice.rateConflict) return { label: `日差差>${RATE_DIFF_TOLERANCE}s`, tone: 'danger' as const };
  if (choice.beatConflict) return { label: `偏振差>${BEAT_DIFF_TOLERANCE}ms`, tone: 'danger' as const };
  if (choice.missing) return { label: '缺方位', tone: 'warning' as const };
  return { label: '一致', tone: 'success' as const };
}

async function confirm() {
  if (!decision.value) return;
  if (preview.value && preview.value.count === 0) {
    ElMessage.warning('至少保留一个方位的读数');
    return;
  }
  submitting.value = true;
  try {
    await importStore.confirmReconcile(decision.value);
    await stepStore.load();
    ElMessage.success('对账结果已确认，均值与结论已重算');
    emit('confirmed');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="group !== null"
    title="双源对账确认"
    width="860px"
    :close-on-click-modal="false"
    @close="emit('close')"
  >
    <div v-if="group" class="reconcile">
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="藏品号">{{ clockNo }}</el-descriptions-item>
        <el-descriptions-item label="测试分钟">{{ group.minuteKey }}</el-descriptions-item>
        <el-descriptions-item label="校表仪时间">{{ machineTimeText }}</el-descriptions-item>
        <el-descriptions-item label="纸单时间">{{ paperTimeText }}</el-descriptions-item>
      </el-descriptions>

      <el-alert
        class="rule"
        type="info"
        :closable="false"
        show-icon
        title="日差相差超过 1 s/d、偏振相差超过 0.5 ms 或一方缺方位时，两值并列保留，由修复师点选采用；一致读数默认取校表仪。"
      />

      <el-table :data="choices" size="small" border class="choice-table">
        <el-table-column prop="position" label="方位" width="70" />
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <StateBadge
              v-if="needsDecision(row)"
              :label="choiceState(row).label"
              :tone="choiceState(row).tone"
            />
            <StateBadge v-else label="一致" tone="success" />
          </template>
        </el-table-column>
        <el-table-column label="校表仪（日差 / 摆幅 / 偏振）" min-width="210">
          <template #default="{ row }">
            <el-radio v-if="row.machine" v-model="row.chosen" value="machine">
              {{ valueText(row.machine?.rate) }} s/d · {{ valueText(row.machine?.amplitude, 0) }}° ·
              {{ valueText(row.machine?.beatError) }} ms
            </el-radio>
            <span v-else class="missing">纸单外缺失</span>
          </template>
        </el-table-column>
        <el-table-column label="纸单（日差 / 摆幅 / 偏振）" min-width="210">
          <template #default="{ row }">
            <el-radio v-if="row.paper" v-model="row.chosen" value="paper">
              {{ valueText(row.paper?.rate) }} s/d · {{ valueText(row.paper?.amplitude, 0) }}° ·
              {{ valueText(row.paper?.beatError) }} ms
            </el-radio>
            <span v-else class="missing">校表仪外缺失</span>
          </template>
        </el-table-column>
      </el-table>

      <div class="scalar-row">
        <div class="scalar-item">
          <span class="label">动力储备：</span>
          <el-radio-group v-model="powerChoice" size="small">
            <el-radio-button v-if="group.machine" value="machine">
              校表仪 {{ group.machine.powerReserve }}h
            </el-radio-button>
            <el-radio-button v-if="group.paper" value="paper">
              纸单 {{ group.paper.powerReserve }}h
            </el-radio-button>
          </el-radio-group>
        </div>
        <div class="scalar-item">
          <span class="label">测试时间：</span>
          <el-radio-group v-model="timeChoice" size="small">
            <el-radio-button v-if="group.machine" value="machine">校表仪</el-radio-button>
            <el-radio-button v-if="group.paper" value="paper">纸单</el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <el-alert
        v-if="group.paperConclusion"
        class="rule"
        type="warning"
        :closable="false"
        show-icon
        :title="`纸单原结论：${group.paperConclusion}（仅作参考，确认后按新均值重算）`"
      />

      <el-card shadow="never" class="preview">
        <template #header><strong>重算预览</strong></template>
        <div class="stats">
          <div><span class="muted">参与方位</span><strong>{{ preview?.count ?? 0 }}</strong> 个</div>
          <div><span class="muted">平均日差</span><strong>{{ preview?.rate ?? 0 }}</strong> s/d</div>
          <div><span class="muted">平均摆幅</span><strong>{{ preview?.amplitude ?? 0 }}</strong> °</div>
          <div><span class="muted">平均偏振</span><strong>{{ preview?.beatError ?? 0 }}</strong> ms</div>
        </div>
        <el-form label-width="92px" size="small">
          <el-form-item label="确认结论">
            <el-input
              v-model="customConclusion"
              :placeholder="`留空则按均值自动判定：${autoConclusion}`"
            />
          </el-form-item>
          <el-form-item label="自动判定">
            <StateBadge
              :label="autoConclusion"
              :tone="autoConclusion === '合格' ? 'success' : autoConclusion === '不合格' ? 'danger' : 'warning'"
            />
            <span class="muted hint">来源将标记为「{{ TEST_SOURCE_LABELS.mixed }}」（只取一源时标该源）</span>
          </el-form-item>
        </el-form>
      </el-card>
    </div>

    <template #footer>
      <el-button @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="confirm">确认采用并更新记录</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.rule {
  margin-top: 12px;
}
.choice-table {
  margin-top: 12px;
}
.missing {
  color: #b4870a;
  font-size: 13px;
}
.scalar-row {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-top: 12px;
}
.scalar-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.label {
  font-size: 13px;
  color: #4a5461;
}
.preview {
  margin-top: 14px;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-bottom: 10px;
  font-size: 13px;
}
.stats strong {
  font-size: 16px;
  margin: 0 4px;
}
.muted {
  color: #7b8592;
  font-size: 12px;
}
.hint {
  margin-left: 10px;
}
</style>
