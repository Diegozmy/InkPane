/**
 * 重复日程展开引擎。
 *
 * 支持 DAILY / WEEKLY / MONTHLY / YEARLY 四种频率，可叠加 interval、byWeekday、
 * count、until 与“单次实例覆盖（改期/改内容/取消）”。
 *
 * 语义要点（与 RFC 5545 对齐）：
 * - `count` 从序列首个实例开始计数，因此被取消的实例也占一个名额。
 * - `until` 为闭区间。给纯日期时表示“包含当天全天”。
 * - MONTHLY 遇到当月不存在该日（如 2 月 31 日）时跳过该月，而不是顺延。
 * - 时区感知：按事件自身时区的墙上时间生成日期，再换算回瞬间，
 *   因此跨夏令时切换不会让日程整体漂移一小时。
 * - 定时事件的时长按“绝对时长”保留（不是墙上时长）。
 */

import type {
  EventOverride,
  EventStatus,
  Occurrence,
  Priority,
  RecurrenceRule,
} from './types.js';
import {
  addDaysToDateKey,
  addMonthsToDateKey,
  compareDateKeys,
  diffInDays,
  isDateKey,
  isValidDateKey,
  isLeapYear,
  daysInMonth,
  instantToZonedParts,
  minutesFromMidnight,
  startOfWeekDateKey,
  toDateKey,
  wallTimeToInstant,
  weekdayOfDateKey,
  type WallDateTime,
} from './time.js';

/** 展开所需的事件最小字段集合。 */
export interface ExpandableEvent {
  id: number;
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

export interface ExpandOptions {
  /** 查询区间起点（含） */
  rangeStart: Date;
  /** 查询区间终点（不含） */
  rangeEnd: Date;
  /** 返回实例数量上限 */
  limit?: number;
  /** 单次展开允许生成的最大日期数，防止异常规则拖垮服务 */
  maxIterations?: number;
  /**
   * 是否展开「主记录本身已取消」的日程。
   * 默认 false：普通查询不会看到取消的序列；
   * 打开「显示已取消」筛选时设为 true，实例会带着 cancelled 状态返回。
   */
  includeCancelledMaster?: boolean;
}

const DEFAULT_LIMIT = 800;
const DEFAULT_MAX_ITERATIONS = 5000;

/* ------------------------------------------------------------------ *
 * 重复规则归一化
 * ------------------------------------------------------------------ */

export function normalizeRecurrenceRule(rule: RecurrenceRule | null | undefined): RecurrenceRule | null {
  if (!rule) return null;

  const interval = Math.max(1, Math.min(365, Math.trunc(rule.interval)));
  const normalized: RecurrenceRule = { freq: rule.freq, interval };

  if (rule.freq === 'WEEKLY' && Array.isArray(rule.byWeekday)) {
    const weekdays = [...new Set(rule.byWeekday)]
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
      .sort((a, b) => a - b);
    if (weekdays.length > 0 && weekdays.length < 7) normalized.byWeekday = weekdays;
  }

  if (typeof rule.count === 'number' && Number.isFinite(rule.count)) {
    normalized.count = Math.max(1, Math.min(500, Math.trunc(rule.count)));
  } else if (typeof rule.until === 'string' && rule.until.trim() !== '') {
    normalized.until = rule.until.trim();
  }

  return normalized;
}

/** 把 `until` 统一折算成事件时区下的日期串，便于闭区间比较。 */
export function resolveUntilDateKey(rule: RecurrenceRule, timezone: string): string | null {
  const raw = rule.until;
  if (!raw) return null;
  if (isDateKey(raw)) return raw;

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime()) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    return toDateKey(parsed, timezone);
  }

  // 无时区信息的“墙上时间”，按事件所在时区解释
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (!local) return null;
  const wall: WallDateTime = {
    year: Number(local[1]),
    month: Number(local[2]),
    day: Number(local[3]),
    hour: local[4] === undefined ? 0 : Number(local[4]),
    minute: local[5] === undefined ? 0 : Number(local[5]),
    second: local[6] === undefined ? 0 : Number(local[6]),
  };
  return toDateKey(wallTimeToInstant(wall, timezone), timezone);
}

/* ------------------------------------------------------------------ *
 * 日期序列生成
 * ------------------------------------------------------------------ */

/**
 * 按重复规则生成“墙上日期”序列，始终从序列首日开始、按时间升序。
 * 调用方负责通过 count / until / 区间上界提前终止迭代。
 */
function* generateSeriesDates(
  rule: RecurrenceRule,
  baseDateKey: string,
  timezone: string,
  maxIterations: number,
): Generator<string> {
  const untilKey = resolveUntilDateKey(rule, timezone);
  let emitted = 0;

  const isExhausted = (dateKey: string): boolean => {
    if (untilKey !== null && compareDateKeys(dateKey, untilKey) > 0) return true;
    return false;
  };

  switch (rule.freq) {
    case 'DAILY': {
      for (let step = 0; emitted < maxIterations; step += 1) {
        const dateKey = addDaysToDateKey(baseDateKey, step * rule.interval);
        if (isExhausted(dateKey)) return;
        emitted += 1;
        yield dateKey;
      }
      return;
    }

    case 'WEEKLY': {
      const weekdays = rule.byWeekday;
      if (!weekdays || weekdays.length === 0) {
        for (let step = 0; emitted < maxIterations; step += 1) {
          const dateKey = addDaysToDateKey(baseDateKey, step * rule.interval * 7);
          if (isExhausted(dateKey)) return;
          emitted += 1;
          yield dateKey;
        }
        return;
      }

      // byWeekday 存在时：以周一为一周起点（RFC 5545 默认 WKST=MO），
      // 每 interval 周输出选中的星期，且不早于序列首日。
      const anchor = startOfWeekDateKey(baseDateKey, 1);
      const ordered = [...weekdays].sort(
        (a, b) => ((a - 1 + 7) % 7) - ((b - 1 + 7) % 7),
      );

      for (let week = 0; emitted < maxIterations; week += 1) {
        const weekStart = addDaysToDateKey(anchor, week * rule.interval * 7);
        let producedInWeek = 0;
        for (const weekday of ordered) {
          const offset = (weekday - 1 + 7) % 7;
          const dateKey = addDaysToDateKey(weekStart, offset);
          if (compareDateKeys(dateKey, baseDateKey) < 0) continue;
          if (isExhausted(dateKey)) return;
          producedInWeek += 1;
          emitted += 1;
          yield dateKey;
          if (emitted >= maxIterations) return;
        }
        // 整周都没有可输出日期且已越过 until，说明序列结束
        if (producedInWeek === 0 && untilKey !== null && compareDateKeys(weekStart, untilKey) > 0) {
          return;
        }
      }
      return;
    }

    case 'MONTHLY': {
      const baseDay = Number(baseDateKey.slice(8, 10));
      for (let step = 0; emitted < maxIterations; step += 1) {
        const moved = addMonthsToDateKey(baseDateKey, step * rule.interval);
        const year = Number(moved.slice(0, 4));
        const month = Number(moved.slice(5, 7));
        // 当月没有该日则跳过，而不是顺延到下个月
        if (baseDay > daysInMonth(year, month)) continue;
        const dateKey = `${moved.slice(0, 7)}-${`${baseDay}`.padStart(2, '0')}`;
        if (isExhausted(dateKey)) return;
        emitted += 1;
        yield dateKey;
      }
      return;
    }

    case 'YEARLY': {
      const month = Number(baseDateKey.slice(5, 7));
      const day = Number(baseDateKey.slice(8, 10));
      for (let step = 0; emitted < maxIterations; step += 1) {
        const year = Number(baseDateKey.slice(0, 4)) + step * rule.interval;
        if (month === 2 && day === 29 && !isLeapYear(year)) continue;
        const dateKey = `${year}-${`${month}`.padStart(2, '0')}-${`${day}`.padStart(2, '0')}`;
        if (isExhausted(dateKey)) return;
        emitted += 1;
        yield dateKey;
      }
      return;
    }

    default:
      return;
  }
}

/* ------------------------------------------------------------------ *
 * 展开主流程
 * ------------------------------------------------------------------ */

export function occurrenceKeyFor(
  allDay: boolean,
  startAt: string,
  timezone: string,
): string {
  if (allDay) {
    return isValidDateKey(startAt) ? startAt : toDateKey(new Date(startAt), timezone);
  }
  const parsed = new Date(startAt);
  if (Number.isNaN(parsed.getTime())) throw new Error(`非法开始时间：${startAt}`);
  return parsed.toISOString();
}

function timedOverlapsRange(startMs: number, endMs: number, rangeStartMs: number, rangeEndMs: number): boolean {
  if (startMs >= rangeEndMs) return false;
  const effectiveEnd = endMs > startMs ? endMs : startMs + 1;
  return effectiveEnd > rangeStartMs;
}

interface OccurrenceDraft {
  occurrenceKey: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
}

function buildOccurrence(
  event: ExpandableEvent,
  draft: OccurrenceDraft,
  override: EventOverride | undefined,
  isRecurring: boolean,
): Occurrence {
  const cancelled = override?.cancelled === true;
  const effective: OccurrenceDraft = {
    occurrenceKey: draft.occurrenceKey,
    allDay: override?.allDay ?? draft.allDay,
    startAt: override?.startAt ?? draft.startAt,
    endAt: override?.endAt ?? draft.endAt,
  };

  return {
    id: `${event.id}:${draft.occurrenceKey}`,
    eventId: event.id,
    occurrenceKey: draft.occurrenceKey,
    title: override?.title ?? event.title,
    description: override?.description ?? event.description,
    location: override?.location ?? event.location,
    categoryId: override?.categoryId ?? event.categoryId,
    priority: override?.priority ?? event.priority,
    status: cancelled ? 'cancelled' : event.status,
    allDay: effective.allDay,
    startAt: effective.startAt,
    endAt: effective.endAt,
    timezone: event.timezone,
    tags: override?.tags ?? event.tags,
    color: event.color,
    remindMinutesBefore: event.remindMinutesBefore,
    isRecurring,
    isModified: override !== undefined && !cancelled,
    rrule: event.rrule,
  };
}

/** 把单个事件在给定区间内展开为若干实例。 */
export function expandEvent(
  event: ExpandableEvent,
  overrides: readonly EventOverride[],
  options: ExpandOptions,
): Occurrence[] {
  if (event.status === 'cancelled' && options.includeCancelledMaster !== true) return [];

  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const rangeStartMs = options.rangeStart.getTime();
  const rangeEndMs = options.rangeEnd.getTime();
  if (rangeEndMs <= rangeStartMs || limit <= 0) return [];

  const overrideMap = new Map<string, EventOverride>();
  for (const override of overrides) overrideMap.set(override.occurrenceKey, override);

  const rule = normalizeRecurrenceRule(event.rrule);
  const results: Occurrence[] = [];

  /* ---- 非重复事件 ---- */
  if (!rule) {
    const occurrenceKey = occurrenceKeyFor(event.allDay, event.startAt, event.timezone);
    const override = overrideMap.get(occurrenceKey);
    if (override?.cancelled) return [];
    const occurrence = buildOccurrence(
      event,
      { occurrenceKey, allDay: event.allDay, startAt: event.startAt, endAt: event.endAt },
      override,
      false,
    );

    const { startAt, endAt, allDay } = occurrence;
    if (allDay) {
      const rangeEndInclusiveKey = toDateKey(new Date(rangeEndMs - 1), event.timezone);
      const rangeStartKey = toDateKey(new Date(rangeStartMs), event.timezone);
      if (
        compareDateKeys(startAt, rangeEndInclusiveKey) <= 0 &&
        compareDateKeys(endAt, rangeStartKey) >= 0
      ) {
        results.push(occurrence);
      }
    } else {
      const startMs = new Date(startAt).getTime();
      const endMs = new Date(endAt).getTime();
      if (timedOverlapsRange(startMs, endMs, rangeStartMs, rangeEndMs)) results.push(occurrence);
    }
    return results;
  }

  /* ---- 重复事件 ---- */
  const seriesStartMs = new Date(event.startAt).getTime();
  if (Number.isNaN(seriesStartMs)) return [];

  const seriesStartParts = instantToZonedParts(new Date(seriesStartMs), event.timezone);
  const rangeEndInclusiveKey = toDateKey(new Date(rangeEndMs - 1), event.timezone);
  const rangeStartKey = toDateKey(new Date(rangeStartMs), event.timezone);

  const baseDateKey = event.allDay
    ? isValidDateKey(event.startAt)
      ? event.startAt
      : toDateKey(new Date(seriesStartMs), event.timezone)
    : `${seriesStartParts.year}-${`${seriesStartParts.month}`.padStart(2, '0')}-${`${seriesStartParts.day}`.padStart(2, '0')}`;

  const durationDays = event.allDay
    ? Math.max(0, diffInDays(baseDateKey, isValidDateKey(event.endAt) ? event.endAt : baseDateKey))
    : Math.max(0, new Date(event.endAt).getTime() - seriesStartMs);

  const seriesMinutes = event.allDay ? 0 : minutesFromMidnight(new Date(seriesStartMs), event.timezone);

  let index = 0;
  for (const dateKey of generateSeriesDates(rule, baseDateKey, event.timezone, maxIterations)) {
    index += 1;
    if (rule.count !== undefined && index > rule.count) break;

    // 已越过查询区间上界，序列按时间升序，可安全终止
    if (compareDateKeys(dateKey, rangeEndInclusiveKey) > 0) break;

    const occurrenceKey = event.allDay
      ? dateKey
      : (() => {
          const parts = dateKey.split('-');
          const startInstant = wallTimeToInstant(
            {
              year: Number(parts[0]),
              month: Number(parts[1]),
              day: Number(parts[2]),
              hour: Math.floor(seriesMinutes / 60),
              minute: seriesMinutes % 60,
            },
            event.timezone,
          );
          return startInstant.toISOString();
        })();

    const override = overrideMap.get(occurrenceKey);
    if (override?.cancelled) continue;

    let draft: OccurrenceDraft;
    if (event.allDay) {
      draft = {
        occurrenceKey,
        allDay: true,
        startAt: dateKey,
        endAt: addDaysToDateKey(dateKey, durationDays),
      };
    } else {
      const startInstant = new Date(occurrenceKey);
      draft = {
        occurrenceKey,
        allDay: false,
        startAt: startInstant.toISOString(),
        endAt: new Date(startInstant.getTime() + durationDays).toISOString(),
      };
    }

    const occurrence = buildOccurrence(event, draft, override, true);

    let inRange: boolean;
    if (occurrence.allDay) {
      inRange =
        compareDateKeys(occurrence.startAt, rangeEndInclusiveKey) <= 0 &&
        compareDateKeys(occurrence.endAt, rangeStartKey) >= 0;
    } else {
      inRange = timedOverlapsRange(
        new Date(occurrence.startAt).getTime(),
        new Date(occurrence.endAt).getTime(),
        rangeStartMs,
        rangeEndMs,
      );
    }

    if (inRange) {
      results.push(occurrence);
      if (results.length >= limit) break;
    }
  }

  return results;
}

/** 序列在给定瞬间之后（含）的第一个实例键；用于「此后所有」拆分。 */
export function firstOccurrenceKeyAtOrAfter(
  event: ExpandableEvent,
  instant: Date,
  overrides: readonly EventOverride[],
): string | null {
  const windowEnd = new Date(instant.getTime() + 400 * 86_400_000);
  const occurrences = expandEvent(event, overrides, {
    rangeStart: instant,
    rangeEnd: windowEnd,
    limit: 1,
    maxIterations: 2000,
  });
  return occurrences[0]?.occurrenceKey ?? null;
}

/** 计算「此后所有」拆分时的原始序列截断键（该日期闭区间之前保留）。 */
export function truncateUntilKeyFor(occurrenceKey: string, allDay: boolean, timezone: string): string {
  const splitDateKey = allDay ? occurrenceKey : toDateKey(new Date(occurrenceKey), timezone);
  return addDaysToDateKey(splitDateKey, -1);
}

/** 覆盖记录是否属于拆分点之后的部分。 */
export function overrideBelongsToFuture(occurrenceKey: string, splitKey: string, allDay: boolean): boolean {
  if (allDay) return compareDateKeys(occurrenceKey, splitKey) >= 0;
  return new Date(occurrenceKey).getTime() >= new Date(splitKey).getTime();
}

/** 生成人类可读的重复规则摘要（用于列表与详情展示）。 */
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const FREQ_LABELS: Record<RecurrenceRule['freq'], string> = {
  DAILY: '每天',
  WEEKLY: '每周',
  MONTHLY: '每月',
  YEARLY: '每年',
};

export function describeRecurrence(rule: RecurrenceRule | null): string {
  const normalized = normalizeRecurrenceRule(rule);
  if (!normalized) return '不重复';

  const every = normalized.interval > 1 ? `每 ${normalized.interval} ` : '';
  const unit =
    normalized.freq === 'DAILY'
      ? '天'
      : normalized.freq === 'WEEKLY'
        ? '周'
        : normalized.freq === 'MONTHLY'
          ? '月'
          : '年';

  let text = normalized.interval > 1 ? `${every}${unit}` : FREQ_LABELS[normalized.freq];

  if (normalized.freq === 'WEEKLY' && normalized.byWeekday && normalized.byWeekday.length > 0) {
    text += ` ${normalized.byWeekday.map((day) => WEEKDAY_LABELS[day] ?? '').join('、')}`;
  }
  if (normalized.count !== undefined) {
    text += `，共 ${normalized.count} 次`;
  } else if (normalized.until) {
    text += `，至 ${normalized.until.slice(0, 10)}`;
  }
  return text;
}

/** 判断某一天是否落在生成的序列内（含 count / until 约束）。 */
export function isDateInSeries(
  rule: RecurrenceRule,
  baseDateKey: string,
  timezone: string,
  targetDateKey: string,
): boolean {
  const normalized = normalizeRecurrenceRule(rule);
  if (!normalized) return false;
  if (compareDateKeys(targetDateKey, baseDateKey) < 0) return false;

  let count = 0;
  for (const dateKey of generateSeriesDates(normalized, baseDateKey, timezone, 5000)) {
    count += 1;
    if (normalized.count !== undefined && count > normalized.count) return false;
    if (dateKey === targetDateKey) return true;
    if (compareDateKeys(dateKey, targetDateKey) > 0) return false;
  }
  return false;
}

/**
 * 拆分序列时使用：返回 `splitDateKey` 之前已经产生的实例数量。
 * 例如“每 2 周、共 10 次”在第 4 个实例处拆分，则剩余次数为 10 - 3 = 7。
 */
export function seriesIndexBefore(
  rule: RecurrenceRule,
  baseDateKey: string,
  timezone: string,
  splitDateKey: string,
): number {
  const normalized = normalizeRecurrenceRule(rule);
  if (!normalized) return 0;

  let index = 0;
  for (const dateKey of generateSeriesDates(normalized, baseDateKey, timezone, 5000)) {
    if (compareDateKeys(dateKey, splitDateKey) >= 0) break;
    if (normalized.count !== undefined && index >= normalized.count) break;
    index += 1;
  }
  return index;
}

/** 供上层计算“某天属于哪个序列实例”时复用。 */
export function weekdayLabel(weekday: number): string {
  return WEEKDAY_LABELS[weekday] ?? '';
}

export function dateKeyWeekday(dateKey: string): number {
  return weekdayOfDateKey(dateKey);
}
