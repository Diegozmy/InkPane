/**
 * 事件仓储：数据库读写全部集中在这里，服务层不直接接触 SQL。
 */

import { bool, type SqliteDatabase } from '../../db/client.js';
import { all, get, run, type SqlValue } from '../../db/query.js';
import {
  EVENT_COLUMNS,
  OVERRIDE_COLUMNS,
  toEventOverride,
  toEventRecord,
  type EventRow,
  type OverrideRow,
} from '../../db/rows.js';
import { toDateKey } from '../../domain/time.js';
import type {
  EventOverride,
  EventRecord,
  EventStatus,
  Priority,
  RecurrenceRule,
} from '../../domain/types.js';

export interface EventWriteModel {
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
  rrule: RecurrenceRule | null;
  color: string | null;
  remindMinutesBefore: number | null;
}

export interface OverrideWriteModel {
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
}

const NOW = (): string => new Date().toISOString();

const EVENT_WRITE_CLAUSE =
  'title = ?, description = ?, location = ?, category_id = ?, priority = ?, status = ?, ' +
  'all_day = ?, start_at = ?, end_at = ?, timezone = ?, tags = ?, rrule = ?, color = ?, ' +
  'remind_minutes_before = ?';

function eventWriteValues(model: EventWriteModel): SqlValue[] {
  return [
    model.title,
    model.description,
    model.location,
    model.categoryId,
    model.priority,
    model.status,
    bool(model.allDay),
    model.startAt,
    model.endAt,
    model.timezone,
    JSON.stringify(model.tags),
    model.rrule ? JSON.stringify(model.rrule) : null,
    model.color,
    model.remindMinutesBefore,
  ];
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

export function countEvents(db: SqliteDatabase, userId: number): number {
  const row = get<{ count: number }>(
    db,
    'SELECT COUNT(*) AS count FROM events WHERE user_id = ?',
    [userId],
  );
  return Number(row?.count ?? 0);
}

export function findEventById(db: SqliteDatabase, userId: number, id: number): EventRecord | null {
  const row = get<EventRow>(
    db,
    `SELECT ${EVENT_COLUMNS} FROM events WHERE id = ? AND user_id = ?`,
    [id, userId],
  );
  return row ? toEventRecord(row) : null;
}

export function insertEvent(
  db: SqliteDatabase,
  userId: number,
  model: EventWriteModel,
): EventRecord {
  const timestamp = NOW();
  const result = run(
    db,
    `INSERT INTO events (user_id, ${EVENT_WRITE_CLAUSE.replace(/ = \?/g, '')}, created_at, updated_at)
     VALUES (?, ${new Array(14).fill('?').join(', ')}, ?, ?)`,
    [userId, ...eventWriteValues(model), timestamp, timestamp],
  );
  const created = findEventById(db, userId, result.lastInsertRowid);
  if (!created) throw new Error('事件写入后无法读回，数据库可能已损坏');
  return created;
}

export function updateEvent(
  db: SqliteDatabase,
  userId: number,
  id: number,
  model: EventWriteModel,
): EventRecord | null {
  const result = run(
    db,
    `UPDATE events SET ${EVENT_WRITE_CLAUSE}, updated_at = ? WHERE id = ? AND user_id = ?`,
    [...eventWriteValues(model), NOW(), id, userId],
  );
  if (result.changes === 0) return null;
  return findEventById(db, userId, id);
}

export function deleteEvent(db: SqliteDatabase, userId: number, id: number): boolean {
  const result = run(db, 'DELETE FROM events WHERE id = ? AND user_id = ?', [id, userId]);
  return result.changes > 0;
}

export interface EventBrowseQuery {
  search?: string;
  categoryIds?: number[];
  priorities?: Priority[];
  statuses?: EventStatus[];
  tags?: string[];
  limit: number;
  offset: number;
  sort: 'startAt' | '-startAt' | 'createdAt' | '-createdAt' | 'title' | '-title';
}

export function listEvents(
  db: SqliteDatabase,
  userId: number,
  query: EventBrowseQuery,
): { items: EventRecord[]; total: number } {
  const where: string[] = ['user_id = ?'];
  const params: SqlValue[] = [userId];

  if (query.search) {
    const like = `%${query.search.replace(/[%_]/g, (match) => `\\${match}`)}%`;
    where.push(
      "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')",
    );
    params.push(like, like, like, like);
  }

  if (query.categoryIds && query.categoryIds.length > 0) {
    where.push(`category_id IN (${query.categoryIds.map(() => '?').join(', ')})`);
    params.push(...query.categoryIds);
  }

  if (query.priorities && query.priorities.length > 0) {
    where.push(`priority IN (${query.priorities.map(() => '?').join(', ')})`);
    params.push(...query.priorities);
  }

  if (query.statuses && query.statuses.length > 0) {
    where.push(`status IN (${query.statuses.map(() => '?').join(', ')})`);
    params.push(...query.statuses);
  }

  if (query.tags && query.tags.length > 0) {
    const tagClauses: string[] = [];
    for (const tag of query.tags) {
      tagClauses.push("tags LIKE ? ESCAPE '\\'");
      params.push(`%"${tag.replace(/[%_"\\]/g, (match) => `\\${match}`)}"%`);
    }
    where.push(`(${tagClauses.join(' OR ')})`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sortColumn = query.sort.replace(/^-/, '');
  const direction = query.sort.startsWith('-') ? 'DESC' : 'ASC';
  const orderSql =
    sortColumn === 'title'
      ? `ORDER BY title COLLATE NOCASE ${direction}, id ASC`
      : `ORDER BY ${sortColumn === 'createdAt' ? 'created_at' : 'start_at'} ${direction}, id ASC`;

  const totalRow = get<{ count: number }>(db, `SELECT COUNT(*) AS count FROM events ${whereSql}`, params);
  const rows = all<EventRow>(
    db,
    `SELECT ${EVENT_COLUMNS} FROM events ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
    [...params, query.limit, query.offset],
  );

  return { items: rows.map(toEventRecord), total: Number(totalRow?.count ?? 0) };
}

/**
 * 取出可能在 [fromMs, toMs) 区间内产生实例的事件。
 * 重复事件必须全部取出（它们可能从很久以前延续至今），
 * 非重复事件则用 SQL 直接按区间剪枝，避免全表扫描。
 */
export function findCandidateEvents(
  db: SqliteDatabase,
  userId: number,
  range: { fromIso: string; toIso: string; fromDateKey: string; toDateKey: string; includeCancelled: boolean },
): EventRecord[] {
  const statusClause = range.includeCancelled ? '' : "status <> 'cancelled' AND ";
  const rows = all<EventRow>(
    db,
    `SELECT ${EVENT_COLUMNS} FROM events
     WHERE user_id = ? AND ${statusClause}(
       rrule IS NOT NULL
       OR (all_day = 0 AND start_at < ? AND end_at >= ?)
       OR (all_day = 1 AND start_at <= ? AND end_at >= ?)
     )
     ORDER BY start_at ASC, id ASC`,
    [userId, range.toIso, range.fromIso, range.toDateKey, range.fromDateKey],
  );
  return rows.map(toEventRecord);
}

/** 供统计使用：取出区间内所有相关事件（含全天）。 */
export function findEventsForStats(
  db: SqliteDatabase,
  userId: number,
  range: { fromIso: string; toIso: string; fromDateKey: string; toDateKey: string },
): EventRecord[] {
  return findCandidateEvents(db, userId, { ...range, includeCancelled: false });
}

export interface EventTimelinePoint {
  id: number;
  title: string;
  allDay: boolean;
  startAt: string;
  endAt: string;
  timezone: string;
  status: EventStatus;
}

export function listUpcomingRaw(
  db: SqliteDatabase,
  userId: number,
  fromIso: string,
  limit: number,
): EventTimelinePoint[] {
  return all<EventTimelinePoint>(
    db,
    `SELECT id, title, all_day AS allDay, start_at AS startAt, end_at AS endAt,
            timezone, status
     FROM events
     WHERE user_id = ? AND status <> 'cancelled' AND rrule IS NULL AND all_day = 0 AND start_at >= ?
     ORDER BY start_at ASC
     LIMIT ?`,
    [userId, fromIso, limit],
  ).map((row) => ({ ...row, allDay: Number(row.allDay) === 1 }));
}

/* ------------------------------------------------------------------ *
 * 实例覆盖（改期 / 改内容 / 取消单次）
 * ------------------------------------------------------------------ */

const OVERRIDE_WRITE_CLAUSE =
  'cancelled = ?, title = ?, description = ?, location = ?, priority = ?, ' +
  'start_at = ?, end_at = ?, all_day = ?, category_id = ?, tags = ?';

function overrideWriteValues(model: OverrideWriteModel): SqlValue[] {
  return [
    bool(model.cancelled),
    model.title,
    model.description,
    model.location,
    model.priority,
    model.startAt,
    model.endAt,
    bool(model.allDay),
    model.categoryId,
    model.tags === null ? null : JSON.stringify(model.tags),
  ];
}

export function listOverrides(db: SqliteDatabase, eventId: number): EventOverride[] {
  return all<OverrideRow>(
    db,
    `SELECT ${OVERRIDE_COLUMNS} FROM event_overrides WHERE event_id = ? ORDER BY occurrence_key ASC`,
    [eventId],
  ).map(toEventOverride);
}

export function listOverridesForEvents(
  db: SqliteDatabase,
  eventIds: readonly number[],
): Map<number, EventOverride[]> {
  const grouped = new Map<number, EventOverride[]>();
  if (eventIds.length === 0) return grouped;

  // SQLite 默认变量上限为 999，分批查询更稳妥
  const batchSize = 500;
  for (let index = 0; index < eventIds.length; index += batchSize) {
    const batch = eventIds.slice(index, index + batchSize);
    const rows = all<OverrideRow>(
      db,
      `SELECT ${OVERRIDE_COLUMNS} FROM event_overrides
       WHERE event_id IN (${batch.map(() => '?').join(', ')})
       ORDER BY occurrence_key ASC`,
      batch,
    );
    for (const row of rows) {
      const override = toEventOverride(row);
      const bucket = grouped.get(override.eventId);
      if (bucket) bucket.push(override);
      else grouped.set(override.eventId, [override]);
    }
  }
  return grouped;
}

export function findOverride(
  db: SqliteDatabase,
  eventId: number,
  occurrenceKey: string,
): EventOverride | null {
  const row = get<OverrideRow>(
    db,
    `SELECT ${OVERRIDE_COLUMNS} FROM event_overrides WHERE event_id = ? AND occurrence_key = ?`,
    [eventId, occurrenceKey],
  );
  return row ? toEventOverride(row) : null;
}

function overrideToWriteModel(override: EventOverride | null): OverrideWriteModel {
  if (!override) {
    return {
      cancelled: false,
      title: null,
      description: null,
      location: null,
      priority: null,
      startAt: null,
      endAt: null,
      allDay: null,
      categoryId: null,
      tags: null,
    };
  }
  return {
    cancelled: override.cancelled,
    title: override.title,
    description: override.description,
    location: override.location,
    priority: override.priority,
    startAt: override.startAt,
    endAt: override.endAt,
    allDay: override.allDay,
    categoryId: override.categoryId,
    tags: override.tags,
  };
}

/** 合并式写入：只覆盖 patch 中显式给出的字段，其余保持原值。 */
export function upsertOverride(
  db: SqliteDatabase,
  eventId: number,
  occurrenceKey: string,
  patch: Partial<OverrideWriteModel>,
): EventOverride {
  const existing = findOverride(db, eventId, occurrenceKey);
  const merged: OverrideWriteModel = { ...overrideToWriteModel(existing) };
  for (const [key, value] of Object.entries(patch) as [keyof OverrideWriteModel, never][]) {
    if (value !== undefined) {
      // 显式赋 null 代表“清空该字段”，与“未提供”语义区分开
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }

  const timestamp = NOW();
  run(
    db,
    `INSERT INTO event_overrides
       (event_id, occurrence_key, ${OVERRIDE_WRITE_CLAUSE.replace(/ = \?/g, '')}, created_at, updated_at)
     VALUES (?, ?, ${new Array(10).fill('?').join(', ')}, ?, ?)
     ON CONFLICT (event_id, occurrence_key) DO UPDATE SET
       ${OVERRIDE_WRITE_CLAUSE}, updated_at = ?`,
    [
      eventId,
      occurrenceKey,
      ...overrideWriteValues(merged),
      timestamp,
      timestamp,
      ...overrideWriteValues(merged),
      timestamp,
    ],
  );

  const saved = findOverride(db, eventId, occurrenceKey);
  if (!saved) throw new Error('实例覆盖写入后无法读回');
  return saved;
}

export function deleteOverride(db: SqliteDatabase, eventId: number, occurrenceKey: string): boolean {
  const result = run(
    db,
    'DELETE FROM event_overrides WHERE event_id = ? AND occurrence_key = ?',
    [eventId, occurrenceKey],
  );
  return result.changes > 0;
}

/** 把某个序列键之后的所有覆盖记录迁移到新事件（用于「此后所有」拆分）。 */
export function reassignOverrides(
  db: SqliteDatabase,
  fromEventId: number,
  toEventId: number,
  fromKeyInclusive: string,
): number {
  const timestamp = NOW();
  run(
    db,
    `DELETE FROM event_overrides
     WHERE event_id = ?
       AND occurrence_key IN (
         SELECT occurrence_key FROM event_overrides WHERE event_id = ? AND occurrence_key >= ?
       )`,
    [toEventId, fromEventId, fromKeyInclusive],
  );
  const result = run(
    db,
    `UPDATE event_overrides SET event_id = ?, updated_at = ?
     WHERE event_id = ? AND occurrence_key >= ?`,
    [toEventId, timestamp, fromEventId, fromKeyInclusive],
  );
  return result.changes;
}

export function deleteOverridesFrom(
  db: SqliteDatabase,
  eventId: number,
  fromKeyInclusive: string,
): number {
  return run(
    db,
    'DELETE FROM event_overrides WHERE event_id = ? AND occurrence_key >= ?',
    [eventId, fromKeyInclusive],
  ).changes;
}

/** 区间查询用的日期键辅助：把瞬间换算为事件时区下的日期串。 */
export function toRangeDateKey(instantIso: string, timezone: string): string {
  return toDateKey(new Date(instantIso), timezone);
}
