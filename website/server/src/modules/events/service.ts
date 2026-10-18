/**
 * 事件服务：业务规则集中在此层，路由只负责解析参数与序列化响应。
 */

import { config } from '../../config.js';
import { getDatabase, transaction, type SqliteDatabase } from '../../db/client.js';
import { BadRequestError, NotFoundError, ValidationError } from '../../http/errors.js';
import {
  expandEvent,
  normalizeRecurrenceRule,
  occurrenceKeyFor,
  seriesIndexBefore,
  truncateUntilKeyFor,
} from '../../domain/recurrence.js';
import {
  addDaysToDateKey,
  compareDateKeys,
  dateKeyToUtcDate,
  diffInDays,
  isDateKey,
  toDateKey,
  wallTimeToInstant,
  type WallDateTime,
} from '../../domain/time.js';
import { systemTimeZone } from '../../domain/time.js';
import type {
  EventOverride,
  EventRecord,
  EventStatus,
  Occurrence,
  Priority,
  RecurrenceRule,
} from '../../domain/types.js';
import type {
  EventCreateInput,
  EventUpdateInput,
  MoveOccurrenceInputDto,
  CancelOccurrenceInputDto,
  OverrideInputDto,
  OccurrenceQueryInput,
  ListEventsQueryInput,
} from '../../domain/schemas.js';
import * as repo from './repository.js';

const MAX_RANGE_DAYS = 400;

export interface ResolvedRange {
  from: Date;
  to: Date;
}

function dateKeyWallParts(dateKey: string): WallDateTime {
  const date = dateKeyToUtcDate(dateKey);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/** 把入参时间统一成存储形态：全天事件用日期串，定时事件用 ISO UTC。 */
export function normalizeStoredTimes(
  input: { startAt: string; endAt: string },
  allDay: boolean,
  timezone: string,
): { startAt: string; endAt: string } {
  if (allDay) {
    const startKey = isDateKey(input.startAt)
      ? input.startAt
      : toDateKey(new Date(input.startAt), timezone);
    const rawEndKey = isDateKey(input.endAt)
      ? input.endAt
      : toDateKey(new Date(input.endAt), timezone);
    const endKey = compareDateKeys(rawEndKey, startKey) < 0 ? startKey : rawEndKey;
    return { startAt: startKey, endAt: endKey };
  }

  const startInstant = isDateKey(input.startAt)
    ? wallTimeToInstant(dateKeyWallParts(input.startAt), timezone)
    : new Date(input.startAt);
  const endInstant = isDateKey(input.endAt)
    ? wallTimeToInstant(dateKeyWallParts(input.endAt), timezone)
    : new Date(input.endAt);

  if (Number.isNaN(startInstant.getTime()) || Number.isNaN(endInstant.getTime())) {
    throw new ValidationError('开始或结束时间无法解析');
  }
  if (endInstant.getTime() <= startInstant.getTime()) {
    throw new ValidationError('结束时间必须晚于开始时间');
  }
  return { startAt: startInstant.toISOString(), endAt: endInstant.toISOString() };
}

/** 解析查询区间，缺省为“当月”，并限制最大跨度以保护服务。 */
export function resolveRange(from?: string, to?: string): ResolvedRange {
  const now = new Date();
  const defaultFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const defaultTo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const fromDate = from ? new Date(from) : defaultFrom;
  const toDate = to ? new Date(to) : defaultTo;

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new BadRequestError('区间参数 from / to 不是合法时间');
  }
  if (toDate.getTime() <= fromDate.getTime()) {
    throw new BadRequestError('区间终点必须晚于起点');
  }
  const spanDays = (toDate.getTime() - fromDate.getTime()) / 86_400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new BadRequestError(`查询区间不得超过 ${MAX_RANGE_DAYS} 天，当前为 ${Math.ceil(spanDays)} 天`);
  }
  return { from: fromDate, to: toDate };
}

function matchesFilters(occurrence: Occurrence, query: OccurrenceQueryInput): boolean {
  if (query.status && query.status.length > 0) {
    if (!query.status.includes(occurrence.status)) return false;
  }
  if (query.includeCancelled !== true && occurrence.status === 'cancelled') return false;

  if (query.categoryId && query.categoryId.length > 0) {
    if (occurrence.categoryId === null || !query.categoryId.includes(occurrence.categoryId)) {
      return false;
    }
  }

  if (query.priority && query.priority.length > 0) {
    if (!query.priority.includes(occurrence.priority)) return false;
  }

  if (query.tag && query.tag.length > 0) {
    const lowered = occurrence.tags.map((tag) => tag.toLowerCase());
    if (!query.tag.some((tag) => lowered.includes(tag.toLowerCase()))) return false;
  }

  if (query.q) {
    const needle = query.q.trim().toLowerCase();
    if (needle.length > 0) {
      const haystack = [
        occurrence.title,
        occurrence.description,
        occurrence.location,
        occurrence.tags.join(' '),
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
  }

  return true;
}

interface OccurrenceSortKey {
  dateKey: string;
  allDayRank: number;
  startMs: number;
  title: string;
}

function occurrenceSortKey(occurrence: Occurrence, timezone: string): OccurrenceSortKey {
  if (occurrence.allDay) {
    return { dateKey: occurrence.startAt.slice(0, 10), allDayRank: 0, startMs: 0, title: occurrence.title };
  }
  const start = new Date(occurrence.startAt);
  return {
    dateKey: toDateKey(start, timezone),
    allDayRank: 1,
    startMs: start.getTime(),
    title: occurrence.title,
  };
}

function compareOccurrences(a: Occurrence, b: Occurrence, timezone: string): number {
  const keyA = occurrenceSortKey(a, timezone);
  const keyB = occurrenceSortKey(b, timezone);
  if (keyA.dateKey !== keyB.dateKey) return keyA.dateKey < keyB.dateKey ? -1 : 1;
  if (keyA.allDayRank !== keyB.allDayRank) return keyA.allDayRank - keyB.allDayRank;
  if (keyA.startMs !== keyB.startMs) return keyA.startMs - keyB.startMs;
  if (keyA.title !== keyB.title) return keyA.title < keyB.title ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface OccurrenceResult {
  items: Occurrence[];
  range: { from: string; to: string };
  timezone: string;
  truncated: boolean;
}

/** 查询区间内的所有日程实例（日历四视图与搜索都走这里）。 */
export function queryOccurrences(
  query: OccurrenceQueryInput,
  db: SqliteDatabase = getDatabase(),
): OccurrenceResult {
  const timezone = systemTimeZone();
  const range = resolveRange(query.from, query.to);
  const totalLimit = Math.min(query.limit ?? 1200, config.maxOccurrencesPerQuery);

  const statuses = query.status ?? [];
  const includeCancelled = query.includeCancelled === true || statuses.includes('cancelled');

  const candidates = repo.findCandidateEvents(db, {
    fromIso: range.from.toISOString(),
    toIso: range.to.toISOString(),
    fromDateKey: toDateKey(range.from, timezone),
    toDateKey: toDateKey(new Date(range.to.getTime() - 1), timezone),
    includeCancelled,
  });

  const overridesByEvent = repo.listOverridesForEvents(
    db,
    candidates.map((event) => event.id),
  );

  const collected: Occurrence[] = [];
  for (const event of candidates) {
    if (collected.length >= totalLimit * 2) break;
    const overrides = overridesByEvent.get(event.id) ?? [];
    collected.push(
      ...expandEvent(event, overrides, {
        rangeStart: range.from,
        rangeEnd: range.to,
        limit: Math.min(totalLimit, config.maxOccurrencesPerQuery),
        includeCancelledMaster: includeCancelled,
      }),
    );
  }

  const filtered = collected.filter((occurrence) => matchesFilters(occurrence, query));
  filtered.sort((a, b) => compareOccurrences(a, b, timezone));

  const truncated = filtered.length > totalLimit;
  return {
    items: filtered.slice(0, totalLimit),
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    timezone,
    truncated,
  };
}

/* ------------------------------------------------------------------ *
 * 事件主体 CRUD
 * ------------------------------------------------------------------ */

function buildWriteModelFromInput(
  input: EventCreateInput,
  timezone: string,
): repo.EventWriteModel {
  const allDay = input.allDay ?? false;
  const times = normalizeStoredTimes(input, allDay, timezone);
  return {
    title: input.title,
    description: input.description ?? '',
    location: input.location ?? '',
    categoryId: input.categoryId ?? null,
    priority: (input.priority ?? 'normal') as Priority,
    status: (input.status ?? 'confirmed') as EventStatus,
    allDay,
    startAt: times.startAt,
    endAt: times.endAt,
    timezone,
    tags: input.tags ?? [],
    rrule: normalizeRecurrenceRule(input.rrule ?? null),
    color: input.color ?? null,
    remindMinutesBefore: input.remindMinutesBefore ?? null,
  };
}

function assertCategoryExists(db: SqliteDatabase, categoryId: number | null | undefined): void {
  if (categoryId === null || categoryId === undefined) return;
  const row = db.prepare('SELECT id FROM categories WHERE id = ?').get(categoryId);
  if (!row) throw new ValidationError(`分类 ${categoryId} 不存在`);
}

export function createEvent(
  input: EventCreateInput,
  db: SqliteDatabase = getDatabase(),
): EventRecord {
  assertCategoryExists(db, input.categoryId);
  const timezone = input.timezone ?? systemTimeZone();
  const model = buildWriteModelFromInput(input, timezone);
  return repo.insertEvent(db, model);
}

export function getEvent(id: number, db: SqliteDatabase = getDatabase()): EventRecord {
  const event = repo.findEventById(db, id);
  if (!event) throw new NotFoundError(`日程 ${id} 不存在`);
  return event;
}

export function updateEvent(
  id: number,
  patch: EventUpdateInput,
  db: SqliteDatabase = getDatabase(),
): EventRecord {
  const existing = repo.findEventById(db, id);
  if (!existing) throw new NotFoundError(`日程 ${id} 不存在`);
  if (patch.categoryId !== undefined) assertCategoryExists(db, patch.categoryId);

  const timezone = patch.timezone ?? existing.timezone;
  const allDay = patch.allDay ?? existing.allDay;
  const times = normalizeStoredTimes(
    { startAt: patch.startAt ?? existing.startAt, endAt: patch.endAt ?? existing.endAt },
    allDay,
    timezone,
  );

  const nextRule =
    patch.rrule === undefined ? existing.rrule : normalizeRecurrenceRule(patch.rrule);

  const model: repo.EventWriteModel = {
    title: patch.title ?? existing.title,
    description: patch.description ?? existing.description,
    location: patch.location ?? existing.location,
    categoryId: patch.categoryId === undefined ? existing.categoryId : patch.categoryId,
    priority: patch.priority ?? existing.priority,
    status: patch.status ?? existing.status,
    allDay,
    startAt: times.startAt,
    endAt: times.endAt,
    timezone,
    tags: patch.tags ?? existing.tags,
    rrule: nextRule,
    color: patch.color === undefined ? existing.color : patch.color,
    remindMinutesBefore:
      patch.remindMinutesBefore === undefined
        ? existing.remindMinutesBefore
        : patch.remindMinutesBefore,
  };

  const updated = repo.updateEvent(db, id, model);
  if (!updated) throw new NotFoundError(`日程 ${id} 不存在`);

  // 从重复改为不重复时，孤立的实例覆盖已无意义，一并清理
  if (existing.rrule && !nextRule) {
    repo.deleteOverridesFrom(db, id, '');
  }

  return updated;
}

export function deleteEvent(id: number, db: SqliteDatabase = getDatabase()): void {
  const deleted = repo.deleteEvent(db, id);
  if (!deleted) throw new NotFoundError(`日程 ${id} 不存在`);
}

export function browseEvents(
  query: ListEventsQueryInput,
  db: SqliteDatabase = getDatabase(),
): { items: EventRecord[]; total: number; limit: number; offset: number } {
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const { items, total } = repo.listEvents(db, {
    search: query.q,
    categoryIds: query.categoryId,
    priorities: query.priority,
    statuses: query.status,
    tags: query.tag,
    limit,
    offset,
    sort: query.sort ?? 'startAt',
  });
  return { items, total, limit, offset };
}

/* ------------------------------------------------------------------ *
 * 实例级操作：改期、取消、局部编辑
 * ------------------------------------------------------------------ */

function splitDateKeyOf(occurrenceKey: string, allDay: boolean, timezone: string): string {
  return allDay ? occurrenceKey : toDateKey(new Date(occurrenceKey), timezone);
}

/** 把主序列按给定实例切成“截断到前一段”。 */
function truncateMasterSeries(
  db: SqliteDatabase,
  event: EventRecord,
  splitKey: string,
): void {
  const rule = normalizeRecurrenceRule(event.rrule);
  if (!rule) return;

  const untilKey = truncateUntilKeyFor(splitKey, event.allDay, event.timezone);
  const baseDateKey = splitDateKeyOf(
    occurrenceKeyFor(event.allDay, event.startAt, event.timezone),
    event.allDay,
    event.timezone,
  );

  repo.deleteOverridesFrom(db, event.id, splitKey);

  // 拆分点就是首个实例时，原序列会变成空序列，直接删除主体
  if (compareDateKeys(untilKey, baseDateKey) < 0) {
    repo.deleteEvent(db, event.id);
    return;
  }

  const nextRule: RecurrenceRule = {
    freq: rule.freq,
    interval: rule.interval,
    ...(rule.byWeekday ? { byWeekday: rule.byWeekday } : {}),
    until: untilKey,
  };

  repo.updateEvent(db, event.id, {
    title: event.title,
    description: event.description,
    location: event.location,
    categoryId: event.categoryId,
    priority: event.priority,
    status: event.status,
    allDay: event.allDay,
    startAt: event.startAt,
    endAt: event.endAt,
    timezone: event.timezone,
    tags: event.tags,
    rrule: nextRule,
    color: event.color,
    remindMinutesBefore: event.remindMinutesBefore,
  });
}

export interface MoveResult {
  scope: 'single' | 'all' | 'future';
  event: EventRecord | null;
  createdEventId: number | null;
  override: EventOverride | null;
}

export function moveOccurrence(
  eventId: number,
  input: MoveOccurrenceInputDto,
  db: SqliteDatabase = getDatabase(),
): MoveResult {
  return transaction(db, () => {
    const event = repo.findEventById(db, eventId);
    if (!event) throw new NotFoundError(`日程 ${eventId} 不存在`);

    const requestedScope = input.scope ?? 'single';
    const firstKey = occurrenceKeyFor(event.allDay, event.startAt, event.timezone);
    const isFirstOccurrence =
      event.allDay
        ? compareDateKeys(input.occurrenceKey, firstKey) === 0
        : new Date(input.occurrenceKey).getTime() <= new Date(firstKey).getTime();

    // 非重复事件、或拖动的是首个实例时，本质都是修改主序列
    let scope: 'single' | 'all' | 'future' = event.rrule ? requestedScope : 'all';
    if (scope === 'future' && isFirstOccurrence) scope = 'all';
    if (scope === 'single' && !event.rrule) scope = 'all';

    if (scope === 'single') {
      const allDay = input.allDay ?? event.allDay;
      const times = normalizeStoredTimes(input, allDay, event.timezone);
      const override = repo.upsertOverride(db, eventId, input.occurrenceKey, {
        startAt: times.startAt,
        endAt: times.endAt,
        allDay,
      });
      return { scope, event: repo.findEventById(db, eventId), createdEventId: null, override };
    }

    if (scope === 'all') {
      const allDay = input.allDay ?? event.allDay;
      if (event.allDay || allDay) {
        const newStartKey = isDateKey(input.startAt)
          ? input.startAt
          : toDateKey(new Date(input.startAt), event.timezone);
        const splitKey = splitDateKeyOf(input.occurrenceKey, true, event.timezone);
        const dayDelta = diffInDays(splitKey, newStartKey);
        const durationDays = Math.max(0, diffInDays(event.startAt.slice(0, 10), event.endAt.slice(0, 10)));

        const movedStart = addDaysToDateKey(event.startAt.slice(0, 10), dayDelta);
        const movedEnd = addDaysToDateKey(movedStart, durationDays);
        const updated = repo.updateEvent(db, eventId, {
          title: event.title,
          description: event.description,
          location: event.location,
          categoryId: event.categoryId,
          priority: event.priority,
          status: event.status,
          allDay: true,
          startAt: movedStart,
          endAt: movedEnd,
          timezone: event.timezone,
          tags: event.tags,
          rrule: event.rrule,
          color: event.color,
          remindMinutesBefore: event.remindMinutesBefore,
        });

        shiftOverrides(db, eventId, (override) => {
          if (override.cancelled || !override.startAt || !override.endAt) return {};
          return {
            startAt: addDaysToDateKey(override.startAt.slice(0, 10), dayDelta),
            endAt: addDaysToDateKey(override.endAt.slice(0, 10), dayDelta),
          };
        });

        return { scope, event: updated, createdEventId: null, override: null };
      }

      const times = normalizeStoredTimes(input, false, event.timezone);
      const delta = new Date(times.startAt).getTime() - new Date(input.occurrenceKey).getTime();
      const movedStart = new Date(new Date(event.startAt).getTime() + delta);
      const movedEnd = new Date(new Date(event.endAt).getTime() + delta);

      const updated = repo.updateEvent(db, eventId, {
        title: event.title,
        description: event.description,
        location: event.location,
        categoryId: event.categoryId,
        priority: event.priority,
        status: event.status,
        allDay: false,
        startAt: movedStart.toISOString(),
        endAt: movedEnd.toISOString(),
        timezone: event.timezone,
        tags: event.tags,
        rrule: event.rrule,
        color: event.color,
        remindMinutesBefore: event.remindMinutesBefore,
      });

      shiftOverrides(db, eventId, (override) => {
        if (override.cancelled || !override.startAt || !override.endAt) return {};
        return {
          startAt: new Date(new Date(override.startAt).getTime() + delta).toISOString(),
          endAt: new Date(new Date(override.endAt).getTime() + delta).toISOString(),
        };
      });

      return { scope, event: updated, createdEventId: null, override: null };
    }

    /* ---- 此后所有：把序列一分为二 ---- */
    const rule = normalizeRecurrenceRule(event.rrule);
    if (!rule) {
      throw new BadRequestError('该日程不是重复日程，无法执行「此后所有」操作');
    }

    const allDay = input.allDay ?? event.allDay;
    const times = normalizeStoredTimes(input, allDay, event.timezone);
    const splitKey = input.occurrenceKey;

    const baseDateKey = splitDateKeyOf(firstKey, event.allDay, event.timezone);
    const splitDateKey = splitDateKeyOf(splitKey, event.allDay, event.timezone);

    const remainingCount =
      rule.count === undefined
        ? undefined
        : Math.max(0, rule.count - seriesIndexBefore(rule, baseDateKey, event.timezone, splitDateKey));

    // 先创建“新的一段”，再把覆盖记录迁移过去，最后截断原序列
    const created = repo.insertEvent(db, {
      title: event.title,
      description: event.description,
      location: event.location,
      categoryId: event.categoryId,
      priority: event.priority,
      status: event.status,
      allDay,
      startAt: times.startAt,
      endAt: times.endAt,
      timezone: event.timezone,
      tags: event.tags,
      rrule: {
        freq: rule.freq,
        interval: rule.interval,
        ...(rule.byWeekday ? { byWeekday: rule.byWeekday } : {}),
        ...(remainingCount !== undefined && remainingCount > 0
          ? { count: remainingCount }
          : rule.until
            ? { until: rule.until }
            : {}),
      },
      color: event.color,
      remindMinutesBefore: event.remindMinutesBefore,
    });

    repo.reassignOverrides(db, eventId, created.id, splitKey);
    truncateMasterSeries(db, event, splitKey);

    return {
      scope,
      event: repo.findEventById(db, eventId),
      createdEventId: created.id,
      override: null,
    };
  });
}

/** 批量平移某事件的所有实例覆盖，保持它们与序列的相对位置。 */
function shiftOverrides(
  db: SqliteDatabase,
  eventId: number,
  mapper: (override: EventOverride) => Partial<repo.OverrideWriteModel>,
): void {
  const overrides = repo.listOverrides(db, eventId);
  for (const override of overrides) {
    const patch = mapper(override);
    if (Object.keys(patch).length === 0) continue;
    repo.upsertOverride(db, eventId, override.occurrenceKey, patch);
  }
}

export interface CancelResult {
  scope: 'single' | 'future';
  event: EventRecord | null;
  deleted: boolean;
  override: EventOverride | null;
}

export function cancelOccurrence(
  eventId: number,
  input: CancelOccurrenceInputDto,
  db: SqliteDatabase = getDatabase(),
): CancelResult {
  return transaction(db, () => {
    const event = repo.findEventById(db, eventId);
    if (!event) throw new NotFoundError(`日程 ${eventId} 不存在`);

    const scope = input.scope ?? 'single';

    if (scope === 'single' || !event.rrule) {
      const override = repo.upsertOverride(db, eventId, input.occurrenceKey, { cancelled: true });
      return { scope: 'single', event, deleted: false, override };
    }

    const firstKey = occurrenceKeyFor(event.allDay, event.startAt, event.timezone);
    const isFirstOccurrence = event.allDay
      ? compareDateKeys(input.occurrenceKey, firstKey) === 0
      : new Date(input.occurrenceKey).getTime() <= new Date(firstKey).getTime();

    // 从首个实例起取消，等价于删除整个序列
    if (isFirstOccurrence) {
      repo.deleteEvent(db, eventId);
      return { scope: 'future', event: null, deleted: true, override: null };
    }

    truncateMasterSeries(db, event, input.occurrenceKey);
    return {
      scope: 'future',
      event: repo.findEventById(db, eventId),
      deleted: repo.findEventById(db, eventId) === null,
      override: null,
    };
  });
}

export function upsertOccurrenceOverride(
  eventId: number,
  input: OverrideInputDto,
  db: SqliteDatabase = getDatabase(),
): EventOverride {
  return transaction(db, () => {
    const event = repo.findEventById(db, eventId);
    if (!event) throw new NotFoundError(`日程 ${eventId} 不存在`);
    if (input.categoryId !== undefined) assertCategoryExists(db, input.categoryId);

    const allDay = input.allDay ?? event.allDay;
    const patch: Partial<repo.OverrideWriteModel> = {};

    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.location !== undefined) patch.location = input.location;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.allDay !== undefined) patch.allDay = input.allDay;

    if (input.startAt !== undefined || input.endAt !== undefined) {
      const times = normalizeStoredTimes(
        {
          startAt: input.startAt ?? event.startAt,
          endAt: input.endAt ?? event.endAt,
        },
        allDay,
        event.timezone,
      );
      patch.startAt = times.startAt;
      patch.endAt = times.endAt;
    }

    return repo.upsertOverride(db, eventId, input.occurrenceKey, patch);
  });
}

export function resetOccurrenceOverride(
  eventId: number,
  occurrenceKey: string,
  db: SqliteDatabase = getDatabase(),
): boolean {
  const event = repo.findEventById(db, eventId);
  if (!event) throw new NotFoundError(`日程 ${eventId} 不存在`);
  return repo.deleteOverride(db, eventId, occurrenceKey);
}

export function listEventOverrides(
  eventId: number,
  db: SqliteDatabase = getDatabase(),
): EventOverride[] {
  const event = repo.findEventById(db, eventId);
  if (!event) throw new NotFoundError(`日程 ${eventId} 不存在`);
  return repo.listOverrides(db, eventId);
}

export function countAllEvents(db: SqliteDatabase = getDatabase()): number {
  return repo.countEvents(db);
}

export { systemTimeZone };
