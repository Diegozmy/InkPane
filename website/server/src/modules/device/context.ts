/**
 * 设备「当前上下文」组装。
 *
 * 语音助手在回答「今天有什么安排」或修改日程前，先通过 `GET /api/device/context`
 * 拿到一份今天的最小只读快照：时间、日程、课程与未完成待办。
 * 与屏幕数据共用同一套时区与查询逻辑，保证语音回答与墨窗显示一致。
 */

import { getDatabase, type SqliteDatabase } from '../../db/client.js';
import { getTimeZoneOffsetMs } from '../../domain/time.js';
import {
  todayDateKey,
  weekdayLabel,
  zonedClockLabel,
  zonedDayRange,
} from '../../domain/display-time.js';
import type {
  DeviceContext,
  DeviceContextEvent,
  DeviceContextTodo,
  Occurrence,
} from '../../domain/types.js';
import { queryOccurrences } from '../events/service.js';
import { readDisplayTimezone } from '../display/settings.js';
import { listOpenTodos } from '../todos/repository.js';
import { listCourseEventIds } from './repository.js';
import { touchDevice } from '../devices/repository.js';

/** 输出上限：语音回答不需要整天的全部数据，也避免响应体过大。 */
export const CONTEXT_EVENT_LIMIT = 20;
export const CONTEXT_COURSE_LIMIT = 20;
export const CONTEXT_TODO_LIMIT = 10;
/** 今日候选查询上限：先取够，再按类别截断。 */
const CONTEXT_QUERY_LIMIT = 500;

function toContextEvent(occurrence: Occurrence, courseEventIds: Set<number>): DeviceContextEvent {
  return {
    id: occurrence.id,
    eventId: occurrence.eventId,
    title: occurrence.title,
    startAt: occurrence.startAt,
    endAt: occurrence.endAt,
    allDay: occurrence.allDay,
    location: occurrence.location,
    isCourse: courseEventIds.has(occurrence.eventId),
  };
}

export function buildDeviceContext(
  userId: number,
  db: SqliteDatabase = getDatabase(),
  now: Date = new Date(),
): DeviceContext {
  const timezone = readDisplayTimezone(db, userId);
  const dayRange = zonedDayRange(timezone, now);

  const occurrences = queryOccurrences(
    {
      from: dayRange.fromIso,
      to: dayRange.toIso,
      includeCancelled: false,
      limit: CONTEXT_QUERY_LIMIT,
    },
    userId,
    db,
  ).items;

  const courseEventIds = listCourseEventIds(db, userId);
  const mapped = occurrences.map((occurrence) => toContextEvent(occurrence, courseEventIds));
  const allEvents = mapped.filter((event) => !event.isCourse);
  const allCourses = mapped.filter((event) => event.isCourse);

  const todos: DeviceContextTodo[] = listOpenTodos(db, userId, CONTEXT_TODO_LIMIT).map((todo) => ({
    id: todo.id,
    title: todo.title,
    dueDate: todo.dueDate,
    priority: todo.priority,
  }));

  return {
    now: {
      iso: now.toISOString(),
      date: todayDateKey(timezone, now),
      time: zonedClockLabel(now, timezone),
      weekday: weekdayLabel(now, timezone),
      utcOffsetMinutes: Math.round(getTimeZoneOffsetMs(now, timezone) / 60_000),
      timezone,
    },
    events: allEvents.slice(0, CONTEXT_EVENT_LIMIT),
    courses: allCourses.slice(0, CONTEXT_COURSE_LIMIT),
    todos,
  };
}

/** 拉取上下文同时刷新设备在线状态（与拉屏一致）。 */
export function getDeviceContext(
  userId: number,
  deviceId: number,
  db: SqliteDatabase = getDatabase(),
  now: Date = new Date(),
): DeviceContext {
  touchDevice(db, deviceId);
  return buildDeviceContext(userId, db, now);
}
