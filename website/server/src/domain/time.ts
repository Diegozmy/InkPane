/**
 * 时间与时区工具。
 *
 * 约定：
 * - 定时事件在存储与传输层一律使用 ISO-8601 UTC 瞬间（如 2025-06-02T01:00:00.000Z）。
 * - 全天事件使用纯日期串 'YYYY-MM-DD'，避免时区造成日期漂移。
 * - 所有“墙上时间”换算依赖 IANA 时区（如 Asia/Shanghai），结合 Intl 计算偏移，
 *   因此夏令时切换、跨时区协作都能保持正确。
 */

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = 周日，6 = 周六 */
  weekday: number;
}

export interface WallDateTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

let utcValidityChecked = false;

/** 校验 IANA 时区标识是否可用。 */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    getFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** 在任意时区下读取给定瞬间的“墙上时间”各字段。 */
export function instantToZonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(instant);
  const bag: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }

  const weekdayShort = bag['weekday'] ?? 'Sun';
  return {
    year: Number(bag['year']),
    month: Number(bag['month']),
    day: Number(bag['day']),
    // hourCycle 为 h23 时不会出现 24，但个别 ICU 版本仍可能返回，这里做一次兜底
    hour: Number(bag['hour']) % 24,
    minute: Number(bag['minute']),
    second: Number(bag['second']),
    weekday: WEEKDAY_INDEX[weekdayShort] ?? 0,
  };
}

/** 给定瞬间在指定时区相对 UTC 的偏移（毫秒）。 */
export function getTimeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = instantToZonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    instant.getUTCMilliseconds(),
  );
  return asIfUtc - instant.getTime();
}

/**
 * 把“墙上时间”换算成真实瞬间。
 * 采用两次偏移修正，可正确处理夏令时切换当天的边界。
 */
export function wallTimeToInstant(wall: WallDateTime, timeZone: string): Date {
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
    wall.second ?? 0,
  );
  const firstGuess = asIfUtc - getTimeZoneOffsetMs(new Date(asIfUtc), timeZone);
  const secondGuess = asIfUtc - getTimeZoneOffsetMs(new Date(firstGuess), timeZone);
  return new Date(secondGuess);
}

export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && DATE_KEY_PATTERN.test(value);
}

/** 校验日期串是否为真实存在的日历日（排除 2025-02-30 这类）。 */
export function isValidDateKey(value: unknown): value is string {
  const match = typeof value === 'string' ? DATE_KEY_PATTERN.exec(value) : null;
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 日期串 → UTC 零点的 Date，仅用于纯日期运算。 */
export function dateKeyToUtcDate(dateKey: string): Date {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) throw new Error(`非法日期串：${dateKey}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

export function utcDateToDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 某瞬间在指定时区的日期串。 */
export function toDateKey(instant: Date, timeZone: string): string {
  const parts = instantToZonedParts(instant, timeZone);
  const month = `${parts.month}`.padStart(2, '0');
  const day = `${parts.day}`.padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const base = dateKeyToUtcDate(dateKey);
  base.setUTCDate(base.getUTCDate() + days);
  return utcDateToDateKey(base);
}

export function addMonthsToDateKey(dateKey: string, months: number): string {
  const base = dateKeyToUtcDate(dateKey);
  const day = base.getUTCDate();
  base.setUTCDate(1);
  base.setUTCMonth(base.getUTCMonth() + months);
  base.setUTCDate(Math.min(day, daysInMonth(base.getUTCFullYear(), base.getUTCMonth() + 1)));
  return utcDateToDateKey(base);
}

export function diffInDays(fromKey: string, toKey: string): number {
  return Math.round((dateKeyToUtcDate(toKey).getTime() - dateKeyToUtcDate(fromKey).getTime()) / MS_PER_DAY);
}

export function compareDateKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function minDateKey(a: string, b: string): string {
  return a <= b ? a : b;
}

export function maxDateKey(a: string, b: string): string {
  return a >= b ? a : b;
}

/** 0 = 周日 ... 6 = 周六 */
export function weekdayOfDateKey(dateKey: string): number {
  return dateKeyToUtcDate(dateKey).getUTCDay();
}

/** 指定日期所在周的第一天；weekStartsOn 默认 1（周一）。 */
export function startOfWeekDateKey(dateKey: string, weekStartsOn = 1): string {
  const weekday = weekdayOfDateKey(dateKey);
  const delta = (weekday - weekStartsOn + 7) % 7;
  return addDaysToDateKey(dateKey, -delta);
}

export function startOfMonthDateKey(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`;
}

export function endOfMonthDateKey(dateKey: string): string {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  return `${dateKey.slice(0, 7)}-${`${daysInMonth(year, month)}`.padStart(2, '0')}`;
}

export function isWeekendDateKey(dateKey: string): boolean {
  const weekday = weekdayOfDateKey(dateKey);
  return weekday === 0 || weekday === 6;
}

/** 某瞬间在指定时区当天 00:00:00 对应的瞬间。 */
export function startOfDayInstant(instant: Date, timeZone: string): Date {
  const parts = instantToZonedParts(instant, timeZone);
  return wallTimeToInstant({ year: parts.year, month: parts.month, day: parts.day }, timeZone);
}

/** 某瞬间在指定时区的当天 23:59:59.999 对应的瞬间。 */
export function endOfDayInstant(instant: Date, timeZone: string): Date {
  const next = startOfDayInstant(instant, timeZone).getTime() + MS_PER_DAY;
  return new Date(next - 1);
}

/** 把日期串与当天分钟数组合成指定时区下的瞬间。 */
export function dateKeyAndMinutesToInstant(
  dateKey: string,
  minutesFromMidnight: number,
  timeZone: string,
): Date {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) throw new Error(`非法日期串：${dateKey}`);
  const totalMinutes = Math.round(minutesFromMidnight);
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return wallTimeToInstant(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour,
      minute,
    },
    timeZone,
  );
}

/** 该瞬间在指定时区当天已过的分钟数。 */
export function minutesFromMidnight(instant: Date, timeZone: string): number {
  const parts = instantToZonedParts(instant, timeZone);
  return parts.hour * 60 + parts.minute;
}

/** 取服务器运行环境的建议时区。 */
export function systemTimeZone(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(resolved) ? resolved : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** 测试辅助：重置时区格式化器缓存。 */
export function __resetTimeZoneCache(): void {
  formatterCache.clear();
  utcValidityChecked = false;
}

/** 保持在导出面里，方便调用方显式触发一次 UTC 可用性校验。 */
export function ensureUtcAvailable(): void {
  if (utcValidityChecked) return;
  if (!isValidTimeZone('UTC')) throw new Error('运行环境缺少 UTC 时区数据（ICU 不完整）');
  utcValidityChecked = true;
}
