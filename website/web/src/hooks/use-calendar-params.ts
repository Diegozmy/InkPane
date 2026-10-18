import { useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { addDays, addMonths, fromDateKey, startOfDay, toDateKey } from '@/lib/date';
import type { CalendarView } from '@/types';

export interface CalendarParams {
  view: CalendarView;
  anchor: Date;
  goToDate: (date: Date) => void;
  goPrev: () => void;
  goNext: () => void;
  goToday: () => void;
}

function normalizeView(value: string | undefined, fallback: CalendarView): CalendarView {
  return value === 'month' || value === 'week' || value === 'day' ? value : fallback;
}

/**
 * 视图与焦点日期存放在 URL 中（/calendar/week?d=2025-06-02），
 * 因此刷新、分享链接、浏览器前进后退都能保持同一视图状态。
 */
export function useCalendarParams(defaultView: CalendarView = 'month'): CalendarParams {
  const params = useParams<{ view?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = normalizeView(params.view, defaultView);

  const anchor = useMemo(() => {
    const raw = searchParams.get('d');
    if (!raw) return startOfDay(new Date());
    const parsed = fromDateKey(raw);
    return Number.isNaN(parsed.getTime()) ? startOfDay(new Date()) : startOfDay(parsed);
  }, [searchParams]);

  const goToDate = useCallback(
    (date: Date) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set('d', toDateKey(date));
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const goPrev = useCallback(() => {
    const next =
      view === 'month' ? addMonths(anchor, -1) : view === 'week' ? addDays(anchor, -7) : addDays(anchor, -1);
    goToDate(next);
  }, [anchor, view, goToDate]);

  const goNext = useCallback(() => {
    const next =
      view === 'month' ? addMonths(anchor, 1) : view === 'week' ? addDays(anchor, 7) : addDays(anchor, 1);
    goToDate(next);
  }, [anchor, view, goToDate]);

  const goToday = useCallback(() => goToDate(startOfDay(new Date())), [goToDate]);

  return { view, anchor, goToDate, goPrev, goNext, goToday };
}
