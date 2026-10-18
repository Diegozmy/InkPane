/** 日历页：月 / 周 / 日三种视图的统一编排层。 */

import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCategories, useOccurrences } from '@/api/use-calendar-data';
import { useMoveOccurrence } from '@/api/use-calendar-mutations';
import {
  dayRange,
  formatDayTitle,
  formatMonthTitle,
  formatWeekTitle,
  monthGridRange,
  toDateKey,
  weekRange,
} from '@/lib/date';
import { useAppHotkeys, useShellTopBar } from '@/hooks/use-shell';
import { useCalendarParams } from '@/hooks/use-calendar-params';
import { useUiStore } from '@/store/ui-store';
import { CalendarToolbar } from '@/components/calendar/CalendarToolbar';
import { MonthView } from '@/components/calendar/MonthView';
import { TimeGridView } from '@/components/calendar/TimeGridView';
import {
  buildDayMovePayload,
  buildRangeMovePayload,
  defaultCreateDefaults,
} from '@/components/calendar/move-helpers';
import { CategoryManagerDialog } from '@/components/event/CategoryManagerDialog';
import { ScopeMenu } from '@/components/event/ScopeMenu';
import { FilterDialog } from '@/components/filters/FilterDialog';
import { AppShell } from '@/components/layout/AppShell';
import { Sidebar } from '@/components/layout/Sidebar';
import { CalendarGridSkeleton, ErrorState, InlineAlert, Skeleton } from '@/components/ui';
import { addDaysToDateKey } from '@/lib/date';
import type { MoveOccurrencePayload, Occurrence } from '@/types';

interface PendingMove {
  occurrence: Occurrence;
  payload: MoveOccurrencePayload;
  position: { x: number; y: number };
}

interface PendingDrop {
  occurrence: Occurrence;
  payload: MoveOccurrencePayload;
}

export function CalendarPage(): ReactElement {
  const navigate = useNavigate();
  const { view, anchor, goToDate, goPrev, goNext, goToday } = useCalendarParams();
  const topbar = useShellTopBar();

  const filters = useUiStore((state) => state.filters);
  const patchFilters = useUiStore((state) => state.patchFilters);
  const resolvedTheme = useUiStore((state) => state.resolvedTheme);
  const detailsOccurrence = useUiStore((state) => state.detailsOccurrence);
  const setDetailsOccurrence = useUiStore((state) => state.setDetailsOccurrence);
  const openCreateEditor = useUiStore((state) => state.openCreateEditor);
  const filtersPanelOpen = useUiStore((state) => state.filtersPanelOpen);
  const setFiltersPanelOpen = useUiStore((state) => state.setFiltersPanelOpen);

  const searchRef = useRef<HTMLInputElement>(null);
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  const moveOccurrence = useMoveOccurrence();
  const isDark = resolvedTheme === 'dark';

  const range = useMemo(() => {
    if (view === 'month') return monthGridRange(anchor);
    if (view === 'week') return weekRange(anchor);
    return dayRange(anchor);
  }, [view, anchor]);

  const { from, to, days } = range;

  const { data, isLoading, isError, error, refetch, isFetching } = useOccurrences({
    from: from.toISOString(),
    to: to.toISOString(),
    filters,
  });

  const { data: categories, isLoading: categoriesLoading } = useCategories();

  const occurrences = useMemo(() => data?.items ?? [], [data]);
  const categoriesById = useMemo(
    () => new Map((categories ?? []).map((category) => [category.id, category])),
    [categories],
  );

  const markedDays = useMemo(() => {
    const set = new Set<string>();
    for (const occurrence of occurrences) {
      if (occurrence.allDay) {
        const startKey = occurrence.startAt.slice(0, 10);
        const endKey = occurrence.endAt.slice(0, 10);
        let cursor = startKey;
        // 跨天事件在每个覆盖日期上都打点，最多回溯 60 天防止异常数据
        for (let index = 0; index < 60 && cursor <= endKey; index += 1) {
          set.add(cursor);
          cursor = addDaysToDateKey(cursor, 1);
        }
      } else {
        set.add(toDateKey(new Date(occurrence.startAt)));
      }
    }
    return set;
  }, [occurrences]);

  const title = useMemo(() => {
    if (view === 'month') return formatMonthTitle(anchor);
    if (view === 'week') return formatWeekTitle(from, to);
    return formatDayTitle(anchor);
  }, [view, anchor, from, to]);

  const createAt = useCallback(
    (day: Date) => {
      openCreateEditor(defaultCreateDefaults(day));
    },
    [openCreateEditor],
  );

  useAppHotkeys({
    searchRef,
    onCreate: () => createAt(anchor),
    onEscape: () => {
      setPendingMove(null);
      setDetailsOccurrence(null);
    },
  });

  const commitMove = useCallback(
    (target: PendingDrop, scope: 'single' | 'all' | 'future') => {
      moveOccurrence.mutate({
        eventId: target.occurrence.eventId,
        payload: { ...target.payload, scope },
      });
    },
    [moveOccurrence],
  );

  const handleMove = useCallback(
    (occurrence: Occurrence, payload: MoveOccurrencePayload, position?: { x: number; y: number }) => {
      if (occurrence.isRecurring) {
        setPendingMove({
          occurrence,
          payload,
          position: position ?? { x: window.innerWidth / 2 - 116, y: 120 },
        });
        return;
      }
      commitMove({ occurrence, payload }, 'single');
    },
    [commitMove],
  );

  const renderContent = (): ReactElement => {
    if (isError) {
      return (
        <ErrorState
          description="无法加载日程数据。请确认后端服务已启动（默认 http://127.0.0.1:4000）。"
          detail={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      );
    }

    if (isLoading) {
      return view === 'month' ? (
        <CalendarGridSkeleton />
      ) : (
        <div className="stack">
          <Skeleton height="var(--calendar-header-height)" radius="var(--radius-surface)" />
          <Skeleton height={360} radius="var(--radius-surface)" />
        </div>
      );
    }

    if (view === 'month') {
      return (
        <MonthView
          days={days}
          anchor={anchor}
          occurrences={occurrences}
          categoriesById={categoriesById}
          isDark={isDark}
          selectedId={detailsOccurrence?.id ?? null}
          onSelect={setDetailsOccurrence}
          onOpenDay={(day) => navigate(`/calendar/day?d=${toDateKey(day)}`)}
          onCreateAllDay={(day) =>
            openCreateEditor({ startAt: toDateKey(day), endAt: toDateKey(day), allDay: true })
          }
          onMoveToDay={(occurrence, day) =>
            handleMove(occurrence, buildDayMovePayload(occurrence, day))
          }
        />
      );
    }

    if (view === 'week' || view === 'day') {
      return (
        <TimeGridView
          days={days}
          occurrences={occurrences}
          categoriesById={categoriesById}
          isDark={isDark}
          selectedId={detailsOccurrence?.id ?? null}
          onSelect={setDetailsOccurrence}
          onOpenDay={(day) => navigate(`/calendar/day?d=${toDateKey(day)}`)}
          onCreateRange={(day, startMinutes, endMinutes) => {
            const start = new Date(day);
            start.setHours(0, 0, 0, 0);
            start.setMinutes(startMinutes);
            const end = new Date(day);
            end.setHours(0, 0, 0, 0);
            end.setMinutes(endMinutes);
            openCreateEditor({
              startAt: start.toISOString(),
              endAt: end.toISOString(),
              allDay: false,
            });
          }}
          onMoveRange={(occurrence, day, startMinutes, endMinutes) =>
            handleMove(occurrence, buildRangeMovePayload(occurrence, day, startMinutes, endMinutes))
          }
        />
      );
    }

    return <CalendarGridSkeleton />;
  };

  return (
    <AppShell
      topbar={topbar}
      sidebar={
        <Sidebar
          month={anchor}
          selectedDay={anchor}
          markedDays={markedDays}
          occurrences={occurrences}
          categories={categories ?? []}
          filters={filters}
          isDark={isDark}
          isLoadingCategories={categoriesLoading}
          onSelectDay={goToDate}
          onChangeMonth={goToDate}
          onSelectOccurrence={setDetailsOccurrence}
          onManageCategories={() => setCategoryManagerOpen(true)}
        />
      }
    >
      <CalendarToolbar
        title={title}
        view={view}
        searchValue={filters.q}
        activeFilterCount={topbar.activeFilterCount}
        onChangeView={(next) => navigate(`/calendar/${next}?d=${toDateKey(anchor)}`)}
        onChangeSearch={(value) => patchFilters({ q: value })}
        onPrev={goPrev}
        onNext={goNext}
        onToday={goToday}
        onCreate={() => createAt(anchor)}
        onOpenFilters={() => setFiltersPanelOpen(true)}
        searchRef={searchRef}
      />

      {isFetching && !isLoading && <div className="loading-bar" role="progressbar" aria-label="正在刷新" />}

      {data?.meta?.truncated && (
        <InlineAlert tone="warning" title="结果过多，已截断显示">
          当前区间内的日程实例超过了上限。建议缩小日期范围，或使用搜索与筛选条件。
        </InlineAlert>
      )}

      <div className="view-host">{renderContent()}</div>

      {pendingMove && (
        <ScopeMenu
          position={pendingMove.position}
          title={pendingMove.occurrence.title}
          onCancel={() => setPendingMove(null)}
          onChoose={(scope) => {
            commitMove({ occurrence: pendingMove.occurrence, payload: pendingMove.payload }, scope);
            setPendingMove(null);
          }}
        />
      )}

      <FilterDialog open={filtersPanelOpen} onClose={() => setFiltersPanelOpen(false)} />

      <CategoryManagerDialog
        open={categoryManagerOpen}
        onClose={() => setCategoryManagerOpen(false)}
      />

      <span className="sr-only" aria-live="polite">
        {isFetching ? '正在加载日程' : `已加载 ${occurrences.length} 条日程`}
      </span>
    </AppShell>
  );
}
