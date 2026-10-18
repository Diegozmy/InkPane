/** 列表（议程）页：按天分组的连续视图，适合规划未来一段时间。 */

import { useCallback, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useCategories, useOccurrences } from '@/api/use-calendar-data';
import { agendaRange, addDays, addDaysToDateKey, formatShortDay, fromDateKey, startOfDay, toDateKey } from '@/lib/date';
import { useAppHotkeys, useShellTopBar } from '@/hooks/use-shell';
import { useUiStore } from '@/store/ui-store';
import { AgendaView } from '@/components/calendar/AgendaView';
import { defaultCreateDefaults } from '@/components/calendar/move-helpers';
import { FilterDialog } from '@/components/filters/FilterDialog';
import { CategoryManagerDialog } from '@/components/event/CategoryManagerDialog';
import { AppShell } from '@/components/layout/AppShell';
import { Sidebar } from '@/components/layout/Sidebar';
import { Button, ErrorState, IconButton, InlineAlert, SegmentedControl, Skeleton } from '@/components/ui';

const WINDOW_DAYS = 30;

export function AgendaPage(): ReactElement {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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

  const range = useMemo(() => agendaRange(anchor, WINDOW_DAYS), [anchor]);
  const { from, to, days } = range;

  const { data, isLoading, isError, error, refetch, isFetching } = useOccurrences({
    from: from.toISOString(),
    to: to.toISOString(),
    filters,
    limit: 2000,
  });

  const { data: categories, isLoading: categoriesLoading } = useCategories();
  const occurrences = useMemo(() => data?.items ?? [], [data]);
  const isDark = resolvedTheme === 'dark';

  const markedDays = useMemo(() => {
    const set = new Set<string>();
    for (const occurrence of occurrences) {
      if (occurrence.allDay) {
        const startKey = occurrence.startAt.slice(0, 10);
        const endKey = occurrence.endAt.slice(0, 10);
        let cursor = startKey;
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

  useAppHotkeys({
    searchRef,
    onCreate: () => openCreateEditor(defaultCreateDefaults(anchor)),
    onEscape: () => setDetailsOccurrence(null),
  });

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
      <div className="toolbar">
        <div className="toolbar__group">
          <Button variant="secondary" leadingIcon="calendar-check" onClick={() => goToDate(startOfDay(new Date()))}>
            今天
          </Button>
          <div className="toolbar__nav">
            <IconButton
              icon="caret-left"
              label="上一段时间"
              size="sm"
              onClick={() => goToDate(addDays(anchor, -WINDOW_DAYS))}
            />
            <IconButton
              icon="caret-right"
              label="下一段时间"
              size="sm"
              onClick={() => goToDate(addDays(anchor, WINDOW_DAYS))}
            />
          </div>
          <h1 className="toolbar__title">
            {formatShortDay(anchor)} 起 {WINDOW_DAYS} 天
          </h1>
        </div>

        <div className="toolbar__group toolbar__group--end">
          <div className="search-field">
            <input
              ref={searchRef}
              type="search"
              className="input"
              placeholder="搜索标题、地点或标签"
              aria-label="搜索日程"
              value={filters.q}
              onChange={(event) => patchFilters({ q: event.target.value })}
            />
          </div>

          <Button
            variant="secondary"
            leadingIcon="filter"
            onClick={() => setFiltersPanelOpen(true)}
          >
            {topbar.activeFilterCount > 0 ? `筛选 ${topbar.activeFilterCount}` : '筛选'}
          </Button>

          <SegmentedControl
            value="agenda"
            ariaLabel="视图"
            onChange={(value) => {
              if (value === 'agenda') return;
              navigate(`/calendar/${value}?d=${toDateKey(anchor)}`);
            }}
            options={[
              { value: 'month' as const, label: '月', icon: 'calendar-dots' as const },
              { value: 'week' as const, label: '周', icon: 'rows' as const },
              { value: 'agenda' as const, label: '列表', icon: 'list-bullets' as const },
            ]}
          />

          <Button
            variant="primary"
            leadingIcon="plus"
            onClick={() => openCreateEditor(defaultCreateDefaults(anchor))}
          >
            新建
          </Button>
        </div>
      </div>

      {isFetching && !isLoading && <div className="loading-bar" role="progressbar" aria-label="正在刷新" />}

      {data?.meta?.truncated && (
        <InlineAlert tone="warning" title="结果过多，已截断显示">
          当前区间内的日程过多，请缩小时间范围或增加筛选条件。
        </InlineAlert>
      )}

      <div className="view-host">
        {isError ? (
          <ErrorState
            description="无法加载日程数据。请确认后端服务已启动。"
            detail={error instanceof Error ? error.message : undefined}
            onRetry={() => void refetch()}
          />
        ) : isLoading ? (
          <div className="stack">
            <Skeleton height={24} width={180} />
            <Skeleton height={72} radius="var(--radius-surface)" />
            <Skeleton height={72} radius="var(--radius-surface)" />
            <Skeleton height={72} radius="var(--radius-surface)" />
          </div>
        ) : (
          <AgendaView
            days={days}
            occurrences={occurrences}
            categoriesById={new Map((categories ?? []).map((category) => [category.id, category]))}
            isDark={isDark}
            selectedId={detailsOccurrence?.id ?? null}
            onSelect={setDetailsOccurrence}
            onCreateAt={(day) => openCreateEditor(defaultCreateDefaults(day))}
          />
        )}
      </div>

      <FilterDialog open={filtersPanelOpen} onClose={() => setFiltersPanelOpen(false)} />
      <CategoryManagerDialog open={categoryManagerOpen} onClose={() => setCategoryManagerOpen(false)} />
    </AppShell>
  );
}
