/** 日历布局计算：事件配色、按天分桶与时间轴定位。 */

import type { CSSProperties } from 'react';
import { eventPalette, readableInk } from '@/lib/color';
import {
  DAY_MINUTES,
  MIN_EVENT_MINUTES,
  addDays,
  minutesFromMidnight,
  occurrenceCoversDay,
  parseOccurrenceEnd,
  parseOccurrenceStart,
  startOfDay,
  toDateKey,
} from '@/lib/date';
import type { Category, Occurrence } from '@/types';

export const DEFAULT_EVENT_COLOR = '#5b6b7f';

export function eventColorOf(
  occurrence: Occurrence,
  categoriesById: Map<number, Category>,
): string {
  if (occurrence.color) return occurrence.color;
  if (occurrence.categoryId !== null) {
    const category = categoriesById.get(occurrence.categoryId);
    if (category) return category.color;
  }
  return DEFAULT_EVENT_COLOR;
}

export function categoryNameOf(
  occurrence: Occurrence,
  categoriesById: Map<number, Category>,
): string {
  if (occurrence.categoryId === null) return '未分类';
  return categoriesById.get(occurrence.categoryId)?.name ?? '未分类';
}

/**
 * 事件配色。
 * soft：浅色底 + 同色系深字（用于月视图与议程）
 * solid：分类色实底 + 自动挑选的高对比文字（用于全天事件条）
 */
export function eventStyle(
  color: string,
  isDark: boolean,
  variant: 'soft' | 'solid' = 'soft',
): CSSProperties {
  if (variant === 'solid') {
    return {
      '--event-bg': color,
      '--event-fg': readableInk(color),
      '--event-accent': color,
      '--event-border': color,
      '--event-solid': color,
    } as CSSProperties;
  }
  const palette = eventPalette(color, isDark);
  return {
    '--event-bg': palette.background,
    '--event-fg': palette.text,
    '--event-accent': color,
    '--event-border': palette.border,
  } as CSSProperties;
}

export function isOccurrencePast(occurrence: Occurrence, now: Date = new Date()): boolean {
  if (occurrence.allDay) {
    const endKey = occurrence.endAt.slice(0, 10);
    return endKey < toDateKey(now);
  }
  return parseOccurrenceEnd(occurrence).getTime() < now.getTime();
}

export function isOccurrenceOngoing(occurrence: Occurrence, now: Date = new Date()): boolean {
  if (occurrence.allDay) return false;
  const start = parseOccurrenceStart(occurrence).getTime();
  const end = parseOccurrenceEnd(occurrence).getTime();
  return start <= now.getTime() && now.getTime() < end;
}

/* ------------------------------------------------------------------ *
 * 月视图分桶
 * ------------------------------------------------------------------ */

export interface MonthEntry {
  occurrence: Occurrence;
  /** 该实例在这一天是否是第一天 / 最后一天，用于连续事件的圆角与文字处理 */
  isStart: boolean;
  isEnd: boolean;
  startsAtMinutes: number;
  isContinuation: boolean;
}

export function buildMonthBuckets(
  occurrences: Occurrence[],
  days: Date[],
): Map<string, MonthEntry[]> {
  const buckets = new Map<string, MonthEntry[]>();
  for (const day of days) buckets.set(toDateKey(day), []);

  const allDay: Occurrence[] = [];
  const timed: Occurrence[] = [];
  for (const occurrence of occurrences) {
    if (occurrence.allDay) allDay.push(occurrence);
    else timed.push(occurrence);
  }

  // 全天事件按“开始早、跨度长”排序，保证多天事件在各天里的相对顺序一致
  allDay.sort((a, b) => {
    if (a.startAt !== b.startAt) return a.startAt < b.startAt ? -1 : 1;
    if (a.endAt !== b.endAt) return a.endAt > b.endAt ? -1 : 1;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });

  timed.sort((a, b) => {
    const startDiff = parseOccurrenceStart(a).getTime() - parseOccurrenceStart(b).getTime();
    if (startDiff !== 0) return startDiff;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });

  for (const day of days) {
    const key = toDateKey(day);
    const bucket = buckets.get(key);
    if (!bucket) continue;

    for (const occurrence of allDay) {
      if (!occurrenceCoversDay(occurrence, day)) continue;
      bucket.push({
        occurrence,
        isStart: occurrence.startAt.slice(0, 10) === key,
        isEnd: occurrence.endAt.slice(0, 10) === key,
        startsAtMinutes: 0,
        isContinuation: occurrence.startAt.slice(0, 10) < key,
      });
    }

    for (const occurrence of timed) {
      if (!occurrenceCoversDay(occurrence, day)) continue;
      const start = parseOccurrenceStart(occurrence);
      const dayStart = startOfDay(day);
      const startsToday = start >= dayStart;
      bucket.push({
        occurrence,
        isStart: startsToday,
        isEnd: parseOccurrenceEnd(occurrence) < addDays(dayStart, 1),
        startsAtMinutes: startsToday ? minutesFromMidnight(start) : 0,
        isContinuation: !startsToday,
      });
    }
  }

  return buckets;
}

/* ------------------------------------------------------------------ *
 * 时间轴布局
 * ------------------------------------------------------------------ */

export interface PositionedEvent {
  occurrence: Occurrence;
  startMinutes: number;
  endMinutes: number;
  columnIndex: number;
  columnCount: number;
  leftPercent: number;
  widthPercent: number;
  continuesFromPreviousDay: boolean;
  continuesToNextDay: boolean;
}

/**
 * 把一天内的定时事件排成不重叠的列。
 * 同一时间簇内按“先到先得”的贪心策略分配列，簇内列数决定横向宽度，
 * 这样重叠日程会并排显示而不是互相遮挡。
 */
export function layoutTimedEvents(occurrences: Occurrence[], day: Date): PositionedEvent[] {
  const dayStart = startOfDay(day);
  const nextDay = addDays(dayStart, 1);

  const items = occurrences
    .filter((occurrence) => !occurrence.allDay && occurrenceCoversDay(occurrence, day))
    .map((occurrence) => {
      const start = parseOccurrenceStart(occurrence);
      const end = parseOccurrenceEnd(occurrence);
      const rawStart = start < dayStart ? 0 : minutesFromMidnight(start);
      const rawEnd = end >= nextDay ? DAY_MINUTES : end <= dayStart ? 0 : minutesFromMidnight(end);
      return {
        occurrence,
        startMinutes: Math.max(0, Math.min(DAY_MINUTES - MIN_EVENT_MINUTES, rawStart)),
        endMinutes: Math.max(rawStart + MIN_EVENT_MINUTES, Math.min(DAY_MINUTES, rawEnd)),
        continuesFromPreviousDay: start < dayStart,
        continuesToNextDay: end >= nextDay,
      };
    })
    .sort((a, b) => a.startMinutes - b.startMinutes || b.endMinutes - a.endMinutes);

  const positioned: PositionedEvent[] = [];
  let cluster: typeof items = [];
  let clusterEnd = -1;

  const flush = (): void => {
    if (cluster.length === 0) return;
    const columnEnds: number[] = [];
    const assignments: number[] = [];

    for (const item of cluster) {
      let column = columnEnds.findIndex((end) => end <= item.startMinutes);
      if (column === -1) {
        columnEnds.push(item.endMinutes);
        column = columnEnds.length - 1;
      } else {
        columnEnds[column] = item.endMinutes;
      }
      assignments.push(column);
    }

    const columnCount = Math.max(1, columnEnds.length);
    const widthPercent = 100 / columnCount;

    cluster.forEach((item, index) => {
      const columnIndex = assignments[index] ?? 0;
      positioned.push({
        occurrence: item.occurrence,
        startMinutes: item.startMinutes,
        endMinutes: item.endMinutes,
        columnIndex,
        columnCount,
        leftPercent: columnIndex * widthPercent,
        widthPercent,
        continuesFromPreviousDay: item.continuesFromPreviousDay,
        continuesToNextDay: item.continuesToNextDay,
      });
    });

    cluster = [];
    clusterEnd = -1;
  };

  for (const item of items) {
    if (cluster.length > 0 && item.startMinutes >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.endMinutes);
  }
  flush();

  return positioned;
}

/** 生成事件块的定位样式（位置全部走 CSS 变量，避免行内 style 触发额外重排）。 */
export function rangeBlockStyle(
  startMinutes: number,
  endMinutes: number,
  leftPercent = 0,
  widthPercent = 100,
): CSSProperties {
  const duration = Math.max(MIN_EVENT_MINUTES, endMinutes - startMinutes);
  return {
    '--block-top': `calc(var(--minute-height) * ${startMinutes})`,
    '--block-height': `calc(var(--minute-height) * ${duration} - 2px)`,
    '--block-left': `calc(${leftPercent}% + 1px)`,
    '--block-width': `calc(${widthPercent}% - 3px)`,
  } as CSSProperties;
}

export function blockPositionStyle(event: PositionedEvent): CSSProperties {
  return rangeBlockStyle(event.startMinutes, event.endMinutes, event.leftPercent, event.widthPercent);
}

export function previewPositionStyle(startMinutes: number, endMinutes: number): CSSProperties {
  const duration = Math.max(MIN_EVENT_MINUTES, endMinutes - startMinutes);
  return {
    '--block-top': `calc(var(--minute-height) * ${startMinutes})`,
    '--block-height': `calc(var(--minute-height) * ${duration} - 2px)`,
  } as CSSProperties;
}

/** 把一组实例按日期串分组，供议程视图使用。 */
export function groupByDayKey(occurrences: Occurrence[], timezoneAgnostic = true): Map<string, Occurrence[]> {
  void timezoneAgnostic;
  const grouped = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const key = occurrence.allDay ? occurrence.startAt.slice(0, 10) : toDateKey(parseOccurrenceStart(occurrence));
    const bucket = grouped.get(key);
    if (bucket) bucket.push(occurrence);
    else grouped.set(key, [occurrence]);
  }
  return grouped;
}
