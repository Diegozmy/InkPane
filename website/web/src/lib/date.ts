/**
 * 日期与时间工具。
 *
 * 约定：界面一律使用浏览器本地时区展示。定时事件是绝对瞬间（ISO UTC），
 * 全天事件是纯日期串，二者都不依赖服务端时区，因此前后端时区不一致也不会错位。
 */

import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { zhCN } from 'date-fns/locale';
import type { Occurrence } from '@/types';

export const WEEK_OPTIONS = { weekStartsOn: 1 as const, locale: zhCN };

export const DAY_MINUTES = 24 * 60;
export const DEFAULT_SNAP_MINUTES = 15;
export const MIN_EVENT_MINUTES = 15;

export const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'] as const;
export const WEEKDAY_LONG = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

/** 本地日期 → 'YYYY-MM-DD' */
export function toDateKey(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/** 'YYYY-MM-DD' → 本地零点的 Date */
export function fromDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return new Date();
  return new Date(year, month - 1, day);
}

export function parseOccurrenceStart(occurrence: Pick<Occurrence, 'allDay' | 'startAt'>): Date {
  return occurrence.allDay ? fromDateKey(occurrence.startAt.slice(0, 10)) : parseISO(occurrence.startAt);
}

export function parseOccurrenceEnd(occurrence: Pick<Occurrence, 'allDay' | 'endAt'>): Date {
  return occurrence.allDay ? fromDateKey(occurrence.endAt.slice(0, 10)) : parseISO(occurrence.endAt);
}

/** 事件实例是否覆盖某一天。 */
export function occurrenceCoversDay(occurrence: Occurrence, day: Date): boolean {
  if (occurrence.allDay) {
    const startKey = occurrence.startAt.slice(0, 10);
    const endKey = occurrence.endAt.slice(0, 10);
    const dayKey = toDateKey(day);
    return dayKey >= startKey && dayKey <= endKey;
  }
  const start = parseOccurrenceStart(occurrence);
  const end = parseOccurrenceEnd(occurrence);
  const dayStart = startOfDay(day);
  const nextDay = addDays(dayStart, 1);
  const effectiveEnd = end.getTime() > start.getTime() ? end : new Date(start.getTime() + 1);
  return start < nextDay && effectiveEnd > dayStart;
}

/** 该实例在其开始当天已过的分钟数（用于时间轴定位）。 */
export function minutesFromMidnight(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function dateAtMinutes(day: Date, minutes: number): Date {
  const result = startOfDay(day);
  result.setMinutes(Math.round(minutes));
  return result;
}

export function snapMinutes(minutes: number, step = DEFAULT_SNAP_MINUTES): number {
  return Math.round(minutes / step) * step;
}

export function clampMinutes(minutes: number): number {
  return Math.max(0, Math.min(DAY_MINUTES, minutes));
}

/** 月视图需要覆盖的完整周网格区间（含上月末与下月初的补白日）。 */
export function monthGridRange(anchor: Date): { from: Date; to: Date; days: Date[] } {
  const gridStart = startOfWeek(startOfMonth(anchor), WEEK_OPTIONS);
  const gridEnd = endOfWeek(endOfMonth(anchor), WEEK_OPTIONS);
  const days: Date[] = [];
  let cursor = gridStart;
  // 最多 6 周，防御性上限
  for (let index = 0; index < 42 && cursor <= gridEnd; index += 1) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return { from: gridStart, to: addDays(gridEnd, 1), days };
}

export function weekRange(anchor: Date): { from: Date; to: Date; days: Date[] } {
  const from = startOfWeek(anchor, WEEK_OPTIONS);
  const days = Array.from({ length: 7 }, (_, index) => addDays(from, index));
  return { from, to: addDays(from, 7), days };
}

export function dayRange(anchor: Date): { from: Date; to: Date; days: Date[] } {
  const from = startOfDay(anchor);
  return { from, to: addDays(from, 1), days: [from] };
}

export function agendaRange(anchor: Date, dayCount = 30): { from: Date; to: Date; days: Date[] } {
  const from = startOfDay(anchor);
  const days = Array.from({ length: dayCount }, (_, index) => addDays(from, index));
  return { from, to: addDays(from, dayCount), days };
}

export function formatTime(date: Date): string {
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return minutes === '00' ? `${hours}:00` : `${hours}:${minutes}`;
}

export function formatTimeRange(start: Date, end: Date): string {
  return `${formatTime(start)} - ${formatTime(end)}`;
}

export function formatMonthTitle(date: Date): string {
  return format(date, 'yyyy 年 M 月', WEEK_OPTIONS);
}

export function formatDayTitle(date: Date): string {
  return format(date, 'yyyy 年 M 月 d 日 EEEE', WEEK_OPTIONS);
}

export function formatShortDay(date: Date): string {
  return format(date, 'M 月 d 日', WEEK_OPTIONS);
}

export function formatWeekTitle(from: Date, to: Date): string {
  const inclusiveEnd = addDays(to, -1);
  if (isSameMonth(from, inclusiveEnd)) {
    return `${format(from, 'yyyy 年 M 月 d 日', WEEK_OPTIONS)} - ${format(inclusiveEnd, 'd 日', WEEK_OPTIONS)}`;
  }
  return `${format(from, 'yyyy 年 M 月 d 日', WEEK_OPTIONS)} - ${format(inclusiveEnd, 'yyyy 年 M 月 d 日', WEEK_OPTIONS)}`;
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return '0 分钟';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} 分钟`;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}

export function formatDayLabel(date: Date, includeYear = false): string {
  return format(date, includeYear ? 'yyyy 年 M 月 d 日' : 'M 月 d 日 EEEE', WEEK_OPTIONS);
}

export function relativeDayLabel(date: Date, today = new Date()): string {
  const diff = differenceInCalendarDays(date, today);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  if (diff > 1 && diff <= 7) return `${diff} 天后`;
  if (diff < -1 && diff >= -7) return `${Math.abs(diff)} 天前`;
  return format(date, 'M 月 d 日', WEEK_OPTIONS);
}

/** 'YYYY-MM-DD' 的纯日历加法，与时区无关。 */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const date = fromDateKey(dateKey);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

export function isWeekend(date: Date): boolean {
  const weekday = date.getDay();
  return weekday === 0 || weekday === 6;
}

export function isWeekendDateKey(dateKey: string): boolean {
  return isWeekend(fromDateKey(dateKey));
}

export function isSameDate(a: Date, b: Date): boolean {
  return isSameDay(a, b);
}

export { addDays, addMonths, isSameMonth, isSameDay };
export { startOfDay, startOfMonth, startOfWeek, endOfMonth, endOfWeek, differenceInCalendarDays };
