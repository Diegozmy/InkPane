/** 统一的领域类型定义：数据库行、领域实体与对外 DTO。 */

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const RECURRENCE_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/**
 * 重复规则。
 *
 * `byWeekday` 使用 0=周日 ... 6=周六，仅对 WEEKLY 生效。
 * `until` 是该事件时区下的“墙上时间”日期或日期时间字符串，语义为“包含该时刻”。
 * `count` 与 `until` 互斥，若同时给出以 count 优先。
 */
export interface RecurrenceRule {
  freq: RecurrenceFrequency;
  interval: number;
  byWeekday?: number[];
  count?: number;
  until?: string;
}

export interface Category {
  id: number;
  name: string;
  color: string;
  icon: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryInput {
  name: string;
  color: string;
  icon?: string | null;
  sortOrder?: number;
}

export interface EventRecord {
  id: number;
  title: string;
  description: string;
  location: string;
  categoryId: number | null;
  priority: Priority;
  status: EventStatus;
  allDay: boolean;
  /** ISO-8601 UTC 瞬间；全天事件为 'YYYY-MM-DD' 日期串 */
  startAt: string;
  endAt: string;
  timezone: string;
  tags: string[];
  rrule: RecurrenceRule | null;
  color: string | null;
  remindMinutesBefore: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 事件主体字段的可选更新集合。 */
export interface EventInput {
  title: string;
  description?: string;
  location?: string;
  categoryId?: number | null;
  priority?: Priority;
  status?: EventStatus;
  allDay?: boolean;
  startAt: string;
  endAt: string;
  timezone?: string;
  tags?: string[];
  rrule?: RecurrenceRule | null;
  color?: string | null;
  remindMinutesBefore?: number | null;
}

/** 针对某个重复实例的覆盖（改期、改内容）或取消。 */
export interface EventOverride {
  id: number;
  eventId: number;
  occurrenceKey: string;
  cancelled: boolean;
  title: string | null;
  description: string | null;
  location: string | null;
  priority: Priority | null;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean | null;
  categoryId: number | null;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
}

/** 展开后的单个日程实例，是前端渲染的唯一数据形状。 */
export interface Occurrence {
  /** 稳定标识：`${eventId}:${occurrenceKey}` */
  id: string;
  eventId: number;
  /** 该实例在原始序列中的起始时刻，用作覆盖/取消的键 */
  occurrenceKey: string;
  title: string;
  description: string;
  location: string;
  categoryId: number | null;
  priority: Priority;
  status: EventStatus;
  allDay: boolean;
  startAt: string;
  endAt: string;
  timezone: string;
  tags: string[];
  color: string | null;
  remindMinutesBefore: number | null;
  isRecurring: boolean;
  /** 该实例是否被单独修改过 */
  isModified: boolean;
  rrule: RecurrenceRule | null;
}

export interface OccurrenceQuery {
  from: string;
  to: string;
  search?: string;
  categoryIds?: number[];
  priorities?: Priority[];
  statuses?: EventStatus[];
  tags?: string[];
  includeCancelled?: boolean;
  limit?: number;
}

export interface MoveOccurrenceInput {
  occurrenceKey: string;
  scope: 'single' | 'all' | 'future';
  startAt: string;
  endAt: string;
  allDay?: boolean;
}

export interface StatsSummary {
  rangeFrom: string;
  rangeTo: string;
  totalOccurrences: number;
  totalMinutes: number;
  allDayCount: number;
  recurringCount: number;
  byCategory: { categoryId: number | null; name: string; color: string; count: number }[];
  byPriority: { priority: Priority; count: number }[];
  byDay: { date: string; count: number }[];
  upcoming: Occurrence[];
}

export interface ReminderItem {
  id: string;
  eventId: number;
  occurrenceKey: string;
  title: string;
  location: string;
  categoryId: number | null;
  startAt: string;
  allDay: boolean;
  /** 提醒应当触发的瞬间（ISO UTC） */
  fireAt: string;
  minutesBefore: number;
}
