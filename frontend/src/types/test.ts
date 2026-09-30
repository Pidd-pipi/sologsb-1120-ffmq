/** 测试方位 */
export type TestPosition = '面上' | '面下' | '12上' | '6上';

export const TEST_POSITIONS: TestPosition[] = ['面上', '面下', '12上', '6上'];

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

/** 原始导入中可能缺方位的读数（导入后会按全量方位补齐） */
export type PartialPositionReading = Partial<Omit<PositionReading, 'position'>> &
  Pick<PositionReading, 'position'>;

/** 数据来源：校表仪、纸单、手工录入，以及双源对账确认后的混合值 */
export type TestSource = 'machine' | 'paper' | 'manual' | 'mixed';

export const TEST_SOURCE_LABELS: Record<TestSource, string> = {
  machine: '校表仪',
  paper: '纸单',
  manual: '手工',
  mixed: '双源确认',
};

/** 走时测试记录（详情页历史仅展示 status = confirmed 的记录） */
export interface TimekeepingTest {
  id: string;
  clockId: string;
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
  /** 确认状态：旧记录无此字段，按原结论展示，视同已确认 */
  status?: 'confirmed';
  /** 读数来源 */
  source?: TestSource;
  /** 双源对账生成时记录两源原始记录 id */
  mergedFrom?: string[];
}

export type TimekeepingTestDraft = Omit<TimekeepingTest, 'id'>;

/** 导入但尚未对账确认的原始走时记录（校表仪 / 纸单各一行） */
export interface RawTestImport {
  id: string;
  clockId: string;
  /** 测试时间（分钟）归一键，双源按藏品号 + 该键配对 */
  minuteKey: string;
  testedAt: number;
  source: 'machine' | 'paper';
  positions: PositionReading[];
  powerReserve: number;
  conclusion: string;
  /** 整批导入的指纹，重试同批直接跳过，不重复新增 */
  batchHash: string;
  /** 行内容指纹，跨批重复内容同样跳过 */
  rowHash: string;
  importedAt: number;
  /** 对账确认后软删除：用于重试去重，不再进入待对账列表 */
  consumed?: boolean;
}

/** 对账阈值 */
export const RATE_DIFF_TOLERANCE = 1; // s/d
export const BEAT_DIFF_TOLERANCE = 0.5; // ms

/** 走时合格判定 */
export function judgeTest(rate: number, beatError: number, amplitude: number): string {
  if (Math.abs(rate) <= 10 && beatError <= 0.8 && amplitude >= 250) return '合格';
  if (Math.abs(rate) <= 30 && beatError <= 1.2) return '可用（需再调）';
  return '不合格';
}
