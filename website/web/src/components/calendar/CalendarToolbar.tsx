/** 日历工具栏：日期导航、视图切换、搜索与新建。 */

import { useRef, type ReactElement, type RefObject } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/ui/icon';
import { Button, IconButton, SegmentedControl, type SegmentedOption } from '@/components/ui/primitives';
import type { CalendarView } from '@/types';

const VIEW_OPTIONS: readonly SegmentedOption<CalendarView>[] = [
  { value: 'month', label: '月', icon: 'calendar-dots' },
  { value: 'week', label: '周', icon: 'rows' },
  { value: 'day', label: '日', icon: 'calendar-blank' },
];

export interface CalendarToolbarProps {
  title: string;
  view: CalendarView;
  searchValue: string;
  activeFilterCount: number;
  onChangeView: (view: CalendarView) => void;
  onChangeSearch: (value: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onCreate: () => void;
  onOpenFilters: () => void;
  onOpenAgenda: () => void;
  /** 供全局快捷键 `/` 聚焦搜索框 */
  searchRef?: RefObject<HTMLInputElement>;
}

export function CalendarToolbar({
  title,
  view,
  searchValue,
  activeFilterCount,
  onChangeView,
  onChangeSearch,
  onPrev,
  onNext,
  onToday,
  onCreate,
  onOpenFilters,
  onOpenAgenda,
  searchRef,
}: CalendarToolbarProps): ReactElement {
  const localRef = useRef<HTMLInputElement>(null);
  const inputRef: RefObject<HTMLInputElement> = searchRef ?? localRef;

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        <Button onClick={onToday} variant="secondary" leadingIcon="calendar-check">
          今天
        </Button>
        <div className="toolbar__nav">
          <IconButton icon="caret-left" label="上一页" size="sm" onClick={onPrev} />
          <IconButton icon="caret-right" label="下一页" size="sm" onClick={onNext} />
        </div>
        <h1 className="toolbar__title">{title}</h1>
      </div>

      <div className="toolbar__group toolbar__group--end">
        <div className="search-field">
          <Icon name="search" size={15} className="search-field__icon" />
          <input
            ref={inputRef}
            type="search"
            className="input"
            placeholder="搜索标题、地点或标签"
            value={searchValue}
            aria-label="搜索日程"
            onChange={(event) => onChangeSearch(event.target.value)}
          />
          {searchValue.length > 0 && (
            <button
              type="button"
              className="search-field__clear"
              aria-label="清空搜索"
              onClick={() => onChangeSearch('')}
            >
              <Icon name="close" size={13} />
            </button>
          )}
        </div>

        <Button
          variant="secondary"
          onClick={onOpenFilters}
          leadingIcon="filter"
          className={cn(activeFilterCount > 0 && 'is-filtering')}
          aria-label={activeFilterCount > 0 ? `筛选（已启用 ${activeFilterCount} 项）` : '筛选'}
        >
          {activeFilterCount > 0 ? `筛选 ${activeFilterCount}` : '筛选'}
        </Button>

        <div className="toolbar__segmented">
          <SegmentedControl
            value={view}
            options={VIEW_OPTIONS}
            onChange={onChangeView}
            ariaLabel="切换日历视图"
          />
        </div>

        <Button variant="ghost" leadingIcon="list-bullets" onClick={onOpenAgenda}>
          列表
        </Button>

        <Button variant="primary" leadingIcon="plus" onClick={onCreate}>
          新建
        </Button>
      </div>
    </div>
  );
}
