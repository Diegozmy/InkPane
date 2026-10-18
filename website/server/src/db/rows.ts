/** 数据库行 ↔ 领域实体的映射。集中处理命名风格转换与 JSON 字段容错。 */

import { fromBool } from './client.js';
import type {
  Category,
  EventOverride,
  EventRecord,
  EventStatus,
  Priority,
  RecurrenceRule,
} from '../domain/types.js';
import { normalizeRecurrenceRule } from '../domain/recurrence.js';

export interface CategoryRow {
  id: number;
  name: string;
  color: string;
  icon: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: number;
  title: string;
  description: string;
  location: string;
  category_id: number | null;
  priority: string;
  status: string;
  all_day: number;
  start_at: string;
  end_at: string;
  timezone: string;
  tags: string;
  rrule: string | null;
  color: string | null;
  remind_minutes_before: number | null;
  created_at: string;
  updated_at: string;
}

export interface OverrideRow {
  id: number;
  event_id: number;
  occurrence_key: string;
  cancelled: number;
  title: string | null;
  description: string | null;
  location: string | null;
  priority: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: number | null;
  category_id: number | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export const CATEGORY_COLUMNS =
  'id, name, color, icon, sort_order, created_at, updated_at';

export const EVENT_COLUMNS = [
  'id',
  'title',
  'description',
  'location',
  'category_id',
  'priority',
  'status',
  'all_day',
  'start_at',
  'end_at',
  'timezone',
  'tags',
  'rrule',
  'color',
  'remind_minutes_before',
  'created_at',
  'updated_at',
].join(', ');

export const OVERRIDE_COLUMNS = [
  'id',
  'event_id',
  'occurrence_key',
  'cancelled',
  'title',
  'description',
  'location',
  'priority',
  'start_at',
  'end_at',
  'all_day',
  'category_id',
  'tags',
  'created_at',
  'updated_at',
].join(', ');

export function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function parseRecurrence(raw: unknown): RecurrenceRule | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return normalizeRecurrenceRule(parsed as RecurrenceRule);
  } catch {
    return null;
  }
}

export function toCategory(row: CategoryRow): Category {
  return {
    id: Number(row.id),
    name: row.name,
    color: row.color,
    icon: row.icon,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toEventRecord(row: EventRow): EventRecord {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description ?? '',
    location: row.location ?? '',
    categoryId: row.category_id === null ? null : Number(row.category_id),
    priority: row.priority as Priority,
    status: row.status as EventStatus,
    allDay: fromBool(row.all_day),
    startAt: row.start_at,
    endAt: row.end_at,
    timezone: row.timezone,
    tags: parseJsonArray(row.tags),
    rrule: parseRecurrence(row.rrule),
    color: row.color,
    remindMinutesBefore:
      row.remind_minutes_before === null ? null : Number(row.remind_minutes_before),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toEventOverride(row: OverrideRow): EventOverride {
  return {
    id: Number(row.id),
    eventId: Number(row.event_id),
    occurrenceKey: row.occurrence_key,
    cancelled: fromBool(row.cancelled),
    title: row.title,
    description: row.description,
    location: row.location,
    priority: (row.priority as Priority | null) ?? null,
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: row.all_day === null || row.all_day === undefined ? null : fromBool(row.all_day),
    categoryId: row.category_id === null ? null : Number(row.category_id),
    tags: row.tags === null || row.tags === undefined ? null : parseJsonArray(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
