/** 测试方位 */
export type TestPosition = '面上' | '面下' | '12上' | '6上';

export const TEST_POSITIONS: TestPosition[] = ['面上', '面下', '12上', '6上'];

/**
 * 走时结果来源：
 * - timegrapher 校表仪打印值
 * - paper 纸单手工记录值
 * - manual 档案内手动录入（旧数据 / 已确认归档）
 */
export type TestSource = 'timegrapher' | 'paper' | 'manual';

export const TEST_SOURCE_LABELS: Record<TestSource, string> = {
  timegrapher: '校表仪',
  paper: '纸单',
  manual: '手动录入',
};

/** 单方位读数 */
export interface PositionReading {
  position: TestPosition;
  /** 日差 s/d */
  rate: number;
  /** 摆幅 ° */
  amplitude: number;
  /** 偏振 ms */
  beatError: number;
}

/** 走时测试记录 */
export interface TimekeepingTest {
  id: string;
  clockId: string;
  /** 藏品号（导入对账用，与 clocks.clockNo 对应） */
  clockNo?: string;
  testedAt: number;
  /** 摆幅 ° */
  amplitude: number;
  /** 偏振 ms */
  beatError: number;
  /** 日差 s/d */
  rate: number;
  positions: PositionReading[];
  /** 动力储备 h */
  powerReserve: number;
  conclusion: string;
  /** 结果来源，缺省视为 manual */
  source?: TestSource;
  /**
   * 是否已经确认采用归档。
   * 旧数据该字段缺省，按「已确认」处理（继续按原结论展示）。
   */
  confirmed?: boolean;
  /** 导入批次号，用于重试幂等（同批不重复新增） */
  batchId?: string;
}

export type TimekeepingTestDraft = Omit<TimekeepingTest, 'id'>;

/** 导入批次：同一来源的一组走时记录 */
export interface ImportBatch {
  batchId: string;
  source: TestSource;
  records: TimekeepingTestDraft[];
}

/** 日差对账阈值：同一方位日差相差超过 1 s/d 即冲突 */
export const RATE_CONFLICT_THRESHOLD = 1;
/** 偏振对账阈值：同一方位偏振相差超过 0.5 ms 即冲突 */
export const BEAT_ERROR_CONFLICT_THRESHOLD = 0.5;

/** 两条方位读数的对账冲突项 */
export interface PositionConflict {
  position: TestPosition;
  /** 缺方位：仅一方有该方位读数 */
  missing: boolean;
  /** 日差相差超过阈值 */
  rateConflict: boolean;
  /** 偏振相差超过阈值 */
  beatErrorConflict: boolean;
}

/** 走时合格判定 */
export function judgeTest(rate: number, beatError: number, amplitude: number): string {
  if (Math.abs(rate) <= 10 && beatError <= 0.8 && amplitude >= 250) return '合格';
  if (Math.abs(rate) <= 30 && beatError <= 1.2) return '可用（需再调）';
  return '不合格';
}

/** 判断记录是否已确认采用（旧数据无 confirmed 字段，视为已确认） */
export function isConfirmed(test: TimekeepingTest): boolean {
  return test.confirmed !== false;
}

/** 取记录来源，缺省按手动录入 */
export function sourceOf(test: TimekeepingTest): TestSource {
  return test.source ?? 'manual';
}

/**
 * 比对两条同方位读数，返回冲突项。
 * 缺方位（一方有值一方无）也算冲突，需要保留两值供选择。
 */
export function detectPositionConflict(
  a: PositionReading | undefined,
  b: PositionReading | undefined,
): PositionConflict {
  const position = (a?.position ?? b?.position ?? '面上') as TestPosition;
  if (!a || !b) {
    return { position, missing: true, rateConflict: false, beatErrorConflict: false };
  }
  return {
    position,
    missing: false,
    rateConflict: Math.abs(a.rate - b.rate) > RATE_CONFLICT_THRESHOLD,
    beatErrorConflict: Math.abs(a.beatError - b.beatError) > BEAT_ERROR_CONFLICT_THRESHOLD,
  };
}

/** 一条方位读数是否存在日差 / 偏振冲突（缺方位不算在此处） */
export function hasValueConflict(conflict: PositionConflict): boolean {
  return conflict.rateConflict || conflict.beatErrorConflict;
}
