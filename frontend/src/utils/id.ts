/** 生成本地唯一 id */
export function newId(prefix = 'id'): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${rand}`;
}

/** 下一个顺序号 */
export function nextSeq(existing: number[]): number {
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

/** 检查顺序号缺失项 */
export function findSeqGaps(seqs: number[]): number[] {
  if (seqs.length === 0) return [];
  const max = Math.max(...seqs);
  const set = new Set(seqs);
  const gaps: number[] = [];
  for (let i = 1; i <= max; i += 1) {
    if (!set.has(i)) gaps.push(i);
  }
  return gaps;
}

/**
 * 测试时间按分钟归一键。
 * 校表仪自动打点与纸单手抄时间常有秒级出入，按藏品号 + 分钟配对，
 * 避免同一轮测试因几秒之差配不上对。
 */
export function minuteKeyOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
}

/** 稳定字符串哈希（cyrb53），用于导入批次 / 行内容去重 */
export function hashContent(value: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
