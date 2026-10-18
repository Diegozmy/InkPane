/** 统一的当前时间来源，便于测试注入固定时刻。 */

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowDate(): Date {
  return new Date();
}
