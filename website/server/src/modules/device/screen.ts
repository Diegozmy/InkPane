/**
 * 设备屏幕数据组装。
 *
 * 一次请求内完成：读取显示布局与刷新间隔、展开今天与当月的日程、取未完成待办、
 * 读取天气缓存（不联网），最后对「数据内容」算 ETag。设备端把 ETag 原样回传，
 * 内容没变时直接拿到 304，省流量也省墨水屏刷新次数。
 */

import { createHash } from 'node:crypto';
import { getDatabase, type SqliteDatabase } from '../../db/client.js';
import { nowIso } from '../../lib/clock.js';
import { toDateKey } from '../../domain/time.js';
import {
  dateLabelOfDateKey,
  describeMonth,
  todayDateKey,
  weekdayLabel,
  zonedClockLabel,
  zonedDayRange,
  zonedMonthRange,
} from '../../domain/display-time.js';
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  type DeviceEvent,
  type DeviceScreenPayload,
  type DeviceTodo,
  type Occurrence,
} from '../../domain/types.js';
import { listCategories } from '../categories.js';
import { queryOccurrences } from '../events/service.js';
import { readDisplayLayout, readDisplayTimezone, readRefreshMinutes } from '../display/settings.js';
import { listOpenTodos } from '../todos/repository.js';
import { getWeatherForScreen } from '../weather/service.js';
import { listCourseEventIds } from './repository.js';

const SCREEN_EVENT_LIMIT = 500;
const SCREEN_MONTH_LIMIT = 1500;
const SCREEN_TODO_LIMIT = 8;

type DeviceScreenContent = Omit<DeviceScreenPayload, 'etag'>;

function toDeviceEvent(
  occurrence: Occurrence,
  courseEventIds: Set<number>,
  categoryColors: Map<number, string>,
): DeviceEvent {
  const categoryColor =
    occurrence.categoryId === null ? null : (categoryColors.get(occurrence.categoryId) ?? null);
  return {
    id: occurrence.id,
    eventId: occurrence.eventId,
    occurrenceKey: occurrence.occurrenceKey,
    title: occurrence.title,
    location: occurrence.location,
    startAt: occurrence.startAt,
    endAt: occurrence.endAt,
    allDay: occurrence.allDay,
    categoryId: occurrence.categoryId,
    // 事件自身没配颜色时跟随分类色，设备端无需再查分类表
    color: occurrence.color ?? categoryColor,
    priority: occurrence.priority,
    isCourse: courseEventIds.has(occurrence.eventId),
  };
}

/** 当月有日程的日期号（只取本月，跨月事件不产生误标）。 */
function collectMonthMarks(
  occurrences: readonly Occurrence[],
  monthPrefix: string,
  timezone: string,
): number[] {
  const days = new Set<number>();
  for (const occurrence of occurrences) {
    const key = occurrence.allDay
      ? occurrence.startAt.slice(0, 10)
      : toDateKey(new Date(occurrence.startAt), timezone);
    if (!key.startsWith(monthPrefix)) continue;
    const day = Number(key.slice(8, 10));
    if (Number.isInteger(day) && day > 0) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

function compareStartAt(a: { startAt: string }, b: { startAt: string }): number {
  if (a.startAt === b.startAt) return 0;
  return a.startAt < b.startAt ? -1 : 1;
}

/**
 * ETag 只覆盖「数据内容」：排除 generatedAt 与 now.iso / now.time，
 * 否则时钟每走一分钟就会换一个 ETag，304 永远命中不了。
 */
function computeEtag(content: DeviceScreenContent): string {
  const source = {
    timezone: content.timezone,
    screen: content.screen,
    now: {
      weekday: content.now.weekday,
      date: content.now.date,
      dateLabel: content.now.dateLabel,
    },
    month: content.month,
    weather: content.weather,
    events: content.events,
    courses: content.courses,
    todos: content.todos,
  };
  return `"${createHash('sha1').update(JSON.stringify(source)).digest('hex')}"`;
}

export function buildDeviceScreenPayload(
  db: SqliteDatabase = getDatabase(),
  now: Date = new Date(),
): DeviceScreenPayload {
  const timezone = readDisplayTimezone(db);
  const layout = readDisplayLayout(db);
  const refreshMinutes = readRefreshMinutes(db);
  const today = todayDateKey(timezone, now);
  const monthPrefix = today.slice(0, 7);
  const dayRange = zonedDayRange(timezone, now);
  const monthRange = zonedMonthRange(timezone, now);

  const todayOccurrences = queryOccurrences(
    { from: dayRange.fromIso, to: dayRange.toIso, includeCancelled: false, limit: SCREEN_EVENT_LIMIT },
    db,
  ).items;
  const monthOccurrences = queryOccurrences(
    { from: monthRange.fromIso, to: monthRange.toIso, includeCancelled: false, limit: SCREEN_MONTH_LIMIT },
    db,
  ).items;

  const courseEventIds = listCourseEventIds(db);
  const categoryColors = new Map(listCategories(db).map((category) => [category.id, category.color]));

  const deviceEvents = [...todayOccurrences]
    .sort(compareStartAt)
    .map((occurrence) => toDeviceEvent(occurrence, courseEventIds, categoryColors));

  const todos: DeviceTodo[] = listOpenTodos(db, SCREEN_TODO_LIMIT).map((todo) => ({
    id: todo.id,
    title: todo.title,
    priority: todo.priority,
    dueDate: todo.dueDate,
  }));

  const content: DeviceScreenContent = {
    generatedAt: nowIso(),
    timezone,
    screen: {
      width: DISPLAY_WIDTH,
      height: DISPLAY_HEIGHT,
      refreshMinutes,
      layout,
    },
    now: {
      iso: now.toISOString(),
      time: zonedClockLabel(now, timezone),
      weekday: weekdayLabel(now, timezone),
      date: today,
      dateLabel: dateLabelOfDateKey(today),
    },
    month: {
      ...describeMonth(today),
      marks: collectMonthMarks(monthOccurrences, monthPrefix, timezone),
    },
    weather: getWeatherForScreen(db),
    events: deviceEvents.filter((event) => !event.isCourse),
    courses: deviceEvents.filter((event) => event.isCourse),
    todos,
  };

  return { ...content, etag: computeEtag(content) };
}
