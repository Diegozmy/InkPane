/**
 * 「按配置时区看日期」的轻量工具。
 *
 * 与 domain/time.ts 的分工：
 * - time.ts 负责瞬间 ↔ 墙上时间的精确换算（含夏令时两次偏移修正）；
 * - 本文件只在其上提供业务语义：今天、未来 7 天、月份网格、中文日期标签。
 *
 * InkPane 的「今天 / 本周 / 月历」都按 display.timezone（默认 Asia/Shanghai）计算，
 * 而不是服务器本机时区，这样部署到其他时区的机器上行为保持一致。
 */

import { nowDate } from '../lib/clock.js';
import {
  addDaysToDateKey,
  dateKeyToUtcDate,
  daysInMonth,
  instantToZonedParts,
  startOfDayInstant,
  toDateKey,
  wallTimeToInstant,
  weekdayOfDateKey,
} from './time.js';

/** 0 = 周日 … 6 = 周六，与 Date#getDay() 对齐。 */
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** 某瞬间在指定时区下的日期串（YYYY-MM-DD）。 */
export function zonedDateKey(instant: Date, timeZone: string): string {
  return toDateKey(instant, timeZone);
}

/** 某瞬间在指定时区下的 HH:mm。 */
export function zonedClockLabel(instant: Date, timeZone: string): string {
  const parts = instantToZonedParts(instant, timeZone);
  return `${`${parts.hour}`.padStart(2, '0')}:${`${parts.minute}`.padStart(2, '0')}`;
}

/** 日期串对应的中文星期标签（周一…周日）。 */
export function weekdayLabelOfDateKey(dateKey: string): string {
  return WEEKDAY_LABELS[weekdayOfDateKey(dateKey)] ?? '周日';
}

/** 某瞬间在指定时区下的中文星期标签。 */
export function weekdayLabel(instant: Date, timeZone: string): string {
  return WEEKDAY_LABELS[instantToZonedParts(instant, timeZone).weekday] ?? '周日';
}

/** 日期串的中文标签，如 2026-10-18 → 10月18日。 */
export function dateLabelOfDateKey(dateKey: string): string {
  const month = Number(dateKey.slice(5, 7));
  const day = Number(dateKey.slice(8, 10));
  return `${month}月${day}日`;
}

/** 某瞬间在指定时区下的「今天」日期串。 */
export function todayDateKey(timeZone: string, now: Date = nowDate()): string {
  return toDateKey(now, timeZone);
}

/** 「本周」= 今天起 7 天（含当天），返回闭区间日期串。 */
export function weekDateKeys(timeZone: string, now: Date = nowDate()): { from: string; to: string } {
  const from = todayDateKey(timeZone, now);
  return { from, to: addDaysToDateKey(from, 6) };
}

/** 指定日期所在月的首末日日期串。 */
export function monthDateKeys(dateKey: string): { from: string; to: string } {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const from = `${dateKey.slice(0, 7)}-01`;
  return { from, to: `${from.slice(0, 7)}-${`${daysInMonth(year, month)}`.padStart(2, '0')}` };
}

/** 某瞬间在指定时区的当天 [00:00, 次日 00:00) 对应瞬间，供区间查询使用。 */
export function zonedDayRange(timeZone: string, now: Date = nowDate()): { fromIso: string; toIso: string } {
  const from = startOfDayInstant(now, timeZone);
  const nextKey = addDaysToDateKey(toDateKey(now, timeZone), 1);
  const to = wallTimeToInstant(
    {
      year: Number(nextKey.slice(0, 4)),
      month: Number(nextKey.slice(5, 7)),
      day: Number(nextKey.slice(8, 10)),
    },
    timeZone,
  );
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

/** 某瞬间所在月在指定时区的 [当月 1 日, 下月 1 日) 瞬间。 */
export function zonedMonthRange(timeZone: string, now: Date = nowDate()): { fromIso: string; toIso: string } {
  const parts = instantToZonedParts(now, timeZone);
  const from = wallTimeToInstant({ year: parts.year, month: parts.month, day: 1 }, timeZone);
  const nextYear = parts.month === 12 ? parts.year + 1 : parts.year;
  const nextMonth = parts.month === 12 ? 1 : parts.month + 1;
  const to = wallTimeToInstant({ year: nextYear, month: nextMonth, day: 1 }, timeZone);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

export interface MonthDescriptor {
  year: number;
  month: number;
  /** 当月 1 日是星期几，0 = 周日 */
  firstWeekday: number;
  daysInMonth: number;
  /** 今天在当月的日号（1–31） */
  today: number;
}

/** 生成设备屏幕需要的月历描述。 */
export function describeMonth(dateKey: string): MonthDescriptor {
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const first = dateKeyToUtcDate(`${dateKey.slice(0, 7)}-01`);
  return {
    year,
    month,
    firstWeekday: first.getUTCDay(),
    daysInMonth: daysInMonth(year, month),
    today: Number(dateKey.slice(8, 10)),
  };
}
