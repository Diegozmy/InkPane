/**
 * 提醒模块。
 *
 * 服务端只负责“算出哪些提醒应当触发”，不主动推送：
 * 前端每 30 秒轮询一次，配合浏览器 Notification API 在本机弹出通知，
 * 因此不需要长连接，也不依赖推送证书。
 */

import { Router } from 'express';
import { getDatabase } from '../db/client.js';
import { get } from '../db/query.js';
import { asyncHandler } from '../http/async-handler.js';
import { reminderQuerySchema } from '../domain/schemas.js';
import { MS_PER_MINUTE } from '../domain/time.js';
import type { ReminderItem } from '../domain/types.js';
import { queryOccurrences } from './events/service.js';

const DEFAULT_WINDOW_MINUTES = 60;
const MAX_LOOKAHEAD_MINUTES = 20_160; // 14 天

/** 库中配置的最大提前提醒量，决定需要向前预读多久的日程。 */
function maxConfiguredLeadMinutes(): number {
  const row = get<{ value: number | null }>(
    getDatabase(),
    'SELECT MAX(remind_minutes_before) AS value FROM events WHERE status <> \'cancelled\'',
  );
  const value = Number(row?.value ?? 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, MAX_LOOKAHEAD_MINUTES);
}

export interface ReminderQuery {
  from?: string;
  to?: string;
  windowMinutes?: number;
}

export function listDueReminders(query: ReminderQuery, now: Date = new Date()): ReminderItem[] {
  const windowStart = query.from ? new Date(query.from) : now;
  const windowMinutes = query.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const windowEnd = query.to
    ? new Date(query.to)
    : new Date(windowStart.getTime() + windowMinutes * MS_PER_MINUTE);

  if (Number.isNaN(windowStart.getTime()) || Number.isNaN(windowEnd.getTime())) return [];
  if (windowEnd.getTime() <= windowStart.getTime()) return [];

  // 提前量可能远大于轮询窗口，因此把展开区间向后延伸最大提前量，避免漏报
  const leadMinutes = maxConfiguredLeadMinutes();
  const expandEnd = new Date(windowEnd.getTime() + leadMinutes * MS_PER_MINUTE);

  const { items } = queryOccurrences(
    {
      from: windowStart.toISOString(),
      to: expandEnd.toISOString(),
      includeCancelled: false,
      limit: 1500,
    },
    getDatabase(),
  );

  const reminders: ReminderItem[] = [];
  for (const occurrence of items) {
    if (occurrence.remindMinutesBefore === null) continue;
    if (occurrence.allDay) continue; // 全天事件没有具体时刻，不做准点提醒

    const startMs = new Date(occurrence.startAt).getTime();
    const fireAtMs = startMs - occurrence.remindMinutesBefore * MS_PER_MINUTE;
    if (fireAtMs < windowStart.getTime() || fireAtMs >= windowEnd.getTime()) continue;

    reminders.push({
      id: `${occurrence.eventId}:${occurrence.occurrenceKey}`,
      eventId: occurrence.eventId,
      occurrenceKey: occurrence.occurrenceKey,
      title: occurrence.title,
      location: occurrence.location,
      categoryId: occurrence.categoryId,
      startAt: occurrence.startAt,
      allDay: occurrence.allDay,
      fireAt: new Date(fireAtMs).toISOString(),
      minutesBefore: occurrence.remindMinutesBefore,
    });
  }

  reminders.sort((a, b) => (a.fireAt < b.fireAt ? -1 : a.fireAt > b.fireAt ? 1 : 0));
  return reminders;
}

export function createRemindersRouter(): Router {
  const router = Router();

  router.get(
    '/due',
    asyncHandler((req, res) => {
      const query = reminderQuerySchema.parse(req.query);
      res.json({ data: listDueReminders(query) });
    }),
  );

  return router;
}
