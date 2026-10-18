/** 统计模块：为「今日概览」与仪表盘提供聚合数据。 */

import { Router } from 'express';
import { getDatabase } from '../db/client.js';
import { listCategories } from './categories.js';
import { asyncHandler } from '../http/async-handler.js';
import { statsQuerySchema } from '../domain/schemas.js';
import { systemTimeZone, toDateKey } from '../domain/time.js';
import type { Occurrence, Priority, StatsSummary } from '../domain/types.js';
import { queryOccurrences, resolveRange } from './events/service.js';

const UPCOMING_LIMIT = 6;

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function buildSummary(
  input: { from?: string; to?: string; timezone?: string },
  now: Date = new Date(),
): StatsSummary {
  const timezone = input.timezone ?? systemTimeZone();
  const range = resolveRange(input.from, input.to);
  const { items } = queryOccurrences(
    {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      includeCancelled: false,
      limit: 2000,
    },
    getDatabase(),
  );

  const categories = new Map(listCategories().map((category) => [category.id, category]));

  const categoryBuckets = new Map<number | null, { count: number; name: string; color: string }>();
  const priorityBuckets = new Map<Priority, number>();
  const dayBuckets = new Map<string, number>();
  let totalMinutes = 0;
  let allDayCount = 0;
  let recurringCount = 0;

  for (const occurrence of items) {
    if (occurrence.allDay) {
      allDayCount += 1;
    } else {
      const durationMs = new Date(occurrence.endAt).getTime() - new Date(occurrence.startAt).getTime();
      if (Number.isFinite(durationMs) && durationMs > 0) totalMinutes += Math.round(durationMs / 60_000);
    }
    if (occurrence.isRecurring) recurringCount += 1;

    const category = occurrence.categoryId === null ? null : categories.get(occurrence.categoryId);
    const key = occurrence.categoryId;
    const bucket = categoryBuckets.get(key);
    if (bucket) bucket.count += 1;
    else {
      categoryBuckets.set(key, {
        count: 1,
        name: category?.name ?? '未分类',
        color: category?.color ?? '#8b8f98',
      });
    }

    priorityBuckets.set(occurrence.priority, (priorityBuckets.get(occurrence.priority) ?? 0) + 1);

    const dayKey = occurrence.allDay
      ? occurrence.startAt.slice(0, 10)
      : toDateKey(new Date(occurrence.startAt), timezone);
    dayBuckets.set(dayKey, (dayBuckets.get(dayKey) ?? 0) + 1);
  }

  const upcoming: Occurrence[] = items
    .filter((occurrence) => {
      if (occurrence.allDay) return occurrence.startAt.slice(0, 10) >= toDateKey(now, timezone);
      return new Date(occurrence.startAt).getTime() >= now.getTime() - 60_000;
    })
    .slice(0, UPCOMING_LIMIT);

  return {
    rangeFrom: range.from.toISOString(),
    rangeTo: range.to.toISOString(),
    totalOccurrences: items.length,
    totalMinutes,
    allDayCount,
    recurringCount,
    byCategory: [...categoryBuckets.entries()]
      .map(([categoryId, value]) => ({ categoryId, ...value }))
      .sort((a, b) => b.count - a.count),
    byPriority: [...priorityBuckets.entries()]
      .map(([priority, count]) => ({ priority, count }))
      // 数量相同时按紧急程度排序，保证同一份数据的输出顺序稳定可测
      .sort((a, b) => b.count - a.count || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]),
    byDay: [...dayBuckets.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    upcoming,
  };
}

export function createStatsRouter(): Router {
  const router = Router();

  router.get(
    '/summary',
    asyncHandler((req, res) => {
      const query = statsQuerySchema.parse(req.query);
      res.json({ data: buildSummary(query) });
    }),
  );

  return router;
}
