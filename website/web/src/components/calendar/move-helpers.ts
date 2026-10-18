/** 移动端/紧凑布局下的日期与时间换算辅助。 */

import { addDaysToDateKey, fromDateKey, toDateKey } from '@/lib/date';
import type { MoveOccurrencePayload, Occurrence } from '@/types';

/** 月视图拖拽：保持原有的具体时间，只把日期整体挪到目标天。 */
export function buildDayMovePayload(occurrence: Occurrence, targetDay: Date): MoveOccurrencePayload {
  const targetKey = toDateKey(targetDay);

  if (occurrence.allDay) {
    const startKey = occurrence.startAt.slice(0, 10);
    const endKey = occurrence.endAt.slice(0, 10);
    const delta =
      (fromDateKey(targetKey).getTime() - fromDateKey(startKey).getTime()) / 86_400_000;
    return {
      occurrenceKey: occurrence.occurrenceKey,
      startAt: addDaysToDateKey(startKey, delta),
      endAt: addDaysToDateKey(endKey, delta),
      allDay: true,
    };
  }

  const originalStart = new Date(occurrence.startAt);
  const originalEnd = new Date(occurrence.endAt);
  const durationMs = Math.max(60_000, originalEnd.getTime() - originalStart.getTime());

  const nextStart = new Date(targetDay);
  nextStart.setHours(originalStart.getHours(), originalStart.getMinutes(), 0, 0);

  return {
    occurrenceKey: occurrence.occurrenceKey,
    startAt: nextStart.toISOString(),
    endAt: new Date(nextStart.getTime() + durationMs).toISOString(),
    allDay: false,
  };
}

/** 时间网格拖拽/缩放：开始时间由落点决定，结束时间取拖拽结果。 */
export function buildRangeMovePayload(
  occurrence: Occurrence,
  targetDay: Date,
  startMinutes: number,
  endMinutes: number,
): MoveOccurrencePayload {
  const start = new Date(targetDay);
  start.setHours(0, 0, 0, 0);
  start.setMinutes(startMinutes);

  const end = new Date(targetDay);
  end.setHours(0, 0, 0, 0);
  end.setMinutes(endMinutes);

  return {
    occurrenceKey: occurrence.occurrenceKey,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    allDay: false,
  };
}

/** 用某天 09:00 - 10:00 作为新建日程的默认区间。 */
export function defaultCreateDefaults(day: Date): { startAt: string; endAt: string; allDay: boolean } {
  const start = new Date(day);
  start.setHours(9, 0, 0, 0);
  const end = new Date(day);
  end.setHours(10, 0, 0, 0);
  return { startAt: start.toISOString(), endAt: end.toISOString(), allDay: false };
}
