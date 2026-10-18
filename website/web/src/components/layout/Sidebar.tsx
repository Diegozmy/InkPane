/** 侧栏：小月历、今日概览、分类筛选与快捷键提示。桌面端常驻，移动端放入抽屉。 */

import { useMemo, type ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { useOccurrences } from '@/api/use-calendar-data';
import { addDays, formatTime, parseOccurrenceStart, startOfDay, toDateKey } from '@/lib/date';
import { useUiStore } from '@/store/ui-store';
import { IconButton } from '@/components/ui/primitives';
import { Skeleton } from '@/components/ui/feedback';
import { MiniMonth } from '@/components/calendar/MiniMonth';
import { eventColorOf, eventStyle } from '@/components/calendar/calendar-utils';
import type { Category, Filters, Occurrence } from '@/types';

export interface SidebarProps {
  /** 小月历显示的月份 */
  month: Date;
  /** 小月历高亮的日期 */
  selectedDay: Date;
  /** 有安排的日期（YYYY-MM-DD） */
  markedDays: ReadonlySet<string>;
  /** 当前视图区间内的实例，用于分类计数 */
  occurrences: Occurrence[];
  categories: Category[];
  filters: Filters;
  isDark: boolean;
  isLoadingCategories: boolean;
  onSelectDay: (date: Date) => void;
  onChangeMonth: (date: Date) => void;
  onSelectOccurrence: (occurrence: Occurrence) => void;
  onManageCategories: () => void;
}

function TodaySummary({
  categoriesById,
  isDark,
  onSelectOccurrence,
}: {
  categoriesById: Map<number, Category>;
  isDark: boolean;
  onSelectOccurrence: (occurrence: Occurrence) => void;
}): ReactElement {
  const filters = useUiStore((state) => state.filters);
  const today = startOfDay(new Date());
  const { data, isLoading } = useOccurrences({
    from: today.toISOString(),
    to: addDays(today, 1).toISOString(),
    filters,
    limit: 100,
  });

  const items = useMemo(() => data?.items ?? [], [data]);

  const stats = useMemo(() => {
    let minutes = 0;
    let allDay = 0;
    for (const occurrence of items) {
      if (occurrence.allDay) {
        allDay += 1;
        continue;
      }
      const start = parseOccurrenceStart(occurrence);
      const end = new Date(occurrence.endAt);
      minutes += Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
    }
    return { minutes, allDay, count: items.length };
  }, [items]);

  const upcoming = useMemo(
    () =>
      items
        .filter((occurrence) => !occurrence.allDay)
        .filter((occurrence) => new Date(occurrence.endAt).getTime() >= Date.now())
        .slice(0, 3),
    [items],
  );

  const hours = Math.floor(stats.minutes / 60);
  const restMinutes = stats.minutes % 60;

  return (
    <div className="sidebar-card">
      <div className="sidebar-card__head">
        <span className="sidebar-card__title">今日概览</span>
        <span className="faint" style={{ fontSize: 'var(--text-xs)' }}>
          {toDateKey(today)}
        </span>
      </div>

      {isLoading ? (
        <div className="today-summary">
          <Skeleton height={54} radius="var(--radius-surface)" />
          <Skeleton height={54} radius="var(--radius-surface)" />
        </div>
      ) : (
        <>
          <div className="today-summary">
            <div className="stat-tile">
              <span className="stat-tile__value">{stats.count}</span>
              <span className="stat-tile__label">今日安排</span>
            </div>
            <div className="stat-tile">
              <span className="stat-tile__value">
                {hours}
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}> 小时</span>
                {restMinutes > 0 ? ` ${restMinutes} 分` : ''}
              </span>
              <span className="stat-tile__label">占用时长</span>
            </div>
          </div>

          {stats.allDay > 0 && (
            <p className="faint" style={{ fontSize: 'var(--text-xs)' }}>
              另有 {stats.allDay} 条全天日程
            </p>
          )}

          {upcoming.length > 0 ? (
            <div className="next-event">
              <span className="sidebar-card__title">接下来</span>
              {upcoming.map((occurrence) => (
                <button
                  key={occurrence.id}
                  type="button"
                  className="next-event__item"
                  style={eventStyle(eventColorOf(occurrence, categoriesById), isDark)}
                  onClick={() => onSelectOccurrence(occurrence)}
                >
                  <span className="next-event__time numeric">
                    {formatTime(parseOccurrenceStart(occurrence))}
                  </span>
                  <span className="next-event__title">{occurrence.title}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="faint" style={{ fontSize: 'var(--text-xs)' }}>
              今天剩余时间没有安排。
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function Sidebar({
  month,
  selectedDay,
  markedDays,
  occurrences,
  categories,
  filters,
  isDark,
  isLoadingCategories,
  onSelectDay,
  onChangeMonth,
  onSelectOccurrence,
  onManageCategories,
}: SidebarProps): ReactElement {
  const toggle = useUiStore((state) => state.toggleFilterValue);
  const patchFilters = useUiStore((state) => state.patchFilters);
  const resetFilters = useUiStore((state) => state.resetFilters);

  const categoriesById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );

  const counts = useMemo(() => {
    const map = new Map<number, number>();
    let uncategorized = 0;
    for (const occurrence of occurrences) {
      if (occurrence.categoryId === null) uncategorized += 1;
      else map.set(occurrence.categoryId, (map.get(occurrence.categoryId) ?? 0) + 1);
    }
    return { map, uncategorized };
  }, [occurrences]);

  return (
    <>
      <MiniMonth
        anchor={month}
        selected={selectedDay}
        markedDays={markedDays}
        onChangeMonth={onChangeMonth}
        onSelectDay={onSelectDay}
      />

      <TodaySummary
        categoriesById={categoriesById}
        isDark={isDark}
        onSelectOccurrence={onSelectOccurrence}
      />

      <div className="sidebar-card">
        <div className="sidebar-card__head">
          <span className="sidebar-card__title">分类</span>
          <IconButton icon="settings" label="管理分类" size="sm" onClick={onManageCategories} />
        </div>

        {isLoadingCategories ? (
          <div className="stack stack--sm">
            <Skeleton height={28} radius="var(--radius-control)" />
            <Skeleton height={28} radius="var(--radius-control)" />
            <Skeleton height={28} radius="var(--radius-control)" />
          </div>
        ) : (
          <div className="category-list">
            {categories.map((category) => {
              const active = filters.categoryIds.includes(category.id);
              return (
                <button
                  key={category.id}
                  type="button"
                  className={cn('category-list__item', active && 'is-active')}
                  style={{ ['--category-color' as string]: category.color }}
                  aria-pressed={active}
                  onClick={() => toggle('categoryIds', category.id)}
                >
                  <span className="category-list__swatch" aria-hidden="true" />
                  <span className="category-list__name">{category.name}</span>
                  <span className="category-list__count">{counts.map.get(category.id) ?? 0}</span>
                </button>
              );
            })}

            {counts.uncategorized > 0 && (
              <div className="category-list__item" style={{ cursor: 'default' }}>
                <span
                  className="category-list__swatch"
                  style={{ background: 'var(--text-faint)' }}
                  aria-hidden="true"
                />
                <span className="category-list__name">未分类</span>
                <span className="category-list__count">{counts.uncategorized}</span>
              </div>
            )}

            {categories.length === 0 && (
              <p className="faint" style={{ fontSize: 'var(--text-xs)' }}>
                还没有分类，创建后可用颜色区分日程。
              </p>
            )}
          </div>
        )}
      </div>

      <div className="sidebar-card">
        <div className="sidebar-card__head">
          <span className="sidebar-card__title">快速筛选</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={resetFilters}>
            重置
          </button>
        </div>

        <div className="row row--wrap" style={{ gap: 'var(--space-1)' }}>
          <button
            type="button"
            className={cn('chip chip--interactive', filters.includeCancelled && 'is-selected')}
            onClick={() => patchFilters({ includeCancelled: !filters.includeCancelled })}
          >
            <span className="chip__text">显示已取消</span>
          </button>
          <button
            type="button"
            className={cn('chip chip--interactive', filters.statuses.includes('tentative') && 'is-selected')}
            onClick={() => toggle('statuses', 'tentative')}
          >
            <span className="chip__text">待定</span>
          </button>
          {(['urgent', 'high', 'normal', 'low'] as const).map((priority) => (
            <button
              key={priority}
              type="button"
              className={cn('chip chip--interactive', filters.priorities.includes(priority) && 'is-selected')}
              onClick={() => toggle('priorities', priority)}
            >
              <span className="chip__text">
                {priority === 'urgent' ? '紧急' : priority === 'high' ? '高' : priority === 'normal' ? '普通' : '低'}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-card">
        <span className="sidebar-card__title">快捷键</span>
        <div className="shortcut-list">
          {[
            { keys: ['T'], label: '回到今天' },
            { keys: ['M', 'W', 'D'], label: '切换月 / 周 / 日' },
            { keys: ['←', '→'], label: '前后翻页' },
            { keys: ['N'], label: '新建日程' },
            { keys: ['/'], label: '搜索' },
            { keys: ['Esc'], label: '收起面板' },
          ].map((row) => (
            <div className="shortcut-row" key={row.label}>
              <span className="muted">{row.label}</span>
              <span className="shortcut-row__keys">
                {row.keys.map((key) => (
                  <kbd className="kbd" key={key}>
                    {key}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
