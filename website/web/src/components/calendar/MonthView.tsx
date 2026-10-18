/** 月视图：7 列网格，支持拖拽改期、双击新建与「展开当日全部」。 */

import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { WEEKDAY_SHORT, isToday, isWeekendDateKey, toDateKey } from '@/lib/date';
import type { Category, Occurrence } from '@/types';
import { Icon } from '@/components/ui/icon';
import { EventChip } from './EventChip';
import { buildMonthBuckets, eventColorOf, type MonthEntry } from './calendar-utils';

export interface MonthViewProps {
  days: Date[];
  anchor: Date;
  occurrences: Occurrence[];
  categoriesById: Map<number, Category>;
  isDark: boolean;
  selectedId: string | null;
  chipsPerDay?: number;
  onSelect: (occurrence: Occurrence) => void;
  onOpenDay: (day: Date) => void;
  onCreateAllDay: (day: Date) => void;
  onMoveToDay: (occurrence: Occurrence, day: Date) => void;
  onDragStateChange?: (occurrence: Occurrence | null) => void;
}

export function MonthView({
  days,
  anchor,
  occurrences,
  categoriesById,
  isDark,
  selectedId,
  chipsPerDay = 4,
  onSelect,
  onOpenDay,
  onCreateAllDay,
  onMoveToDay,
  onDragStateChange,
}: MonthViewProps): ReactElement {
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState(0);

  const buckets = useMemo(() => buildMonthBuckets(occurrences, days), [occurrences, days]);
  const anchorMonth = anchor.getMonth();

  /*
   * 月视图的高度预算随视口变化：6 周网格在大字号下放不下 4 条事件。
   * 实测单元格高度后按真实尺寸算能舒适容纳的条数，超出的折叠成「还有 N 项」，
   * 而不是把内容硬塞进格子里。
   *
   * 高度模型（与 calendar.css 保持一致）：
   *   固定开销 62px = 日期数字 30 + 单元格上下内边距 24 + 头部与列表间距 8
   *   仅放 n 条   = 36n - 8
   *   n 条 + 更多 = 36n + 24
   */
  const ROW_FIXED_COST = 62;
  const CHIP_SLOT = 36;
  const MORE_COST = 24;

  useEffect(() => {
    const element = gridRef.current;
    // jsdom 等环境没有 ResizeObserver，此时退回按 chipsPerDay 显示
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const measure = (): void => {
      const cell = element.querySelector<HTMLElement>('.month__cell');
      setRowHeight(cell ? cell.getBoundingClientRect().height : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [days]);

  /**
   * 决定某一天显示几条、以及是否显示「还有 N 项」。
   * 优先多显示事件：只有当「更多」按钮不占用额外一条事件的位置时才渲染它，
   * 否则靠日期右侧的「N 项」计数 + 点击当天进入日视图来表达还有更多。
   */
  const decide = (entryCount: number, expanded: boolean): { count: number; showMore: boolean } => {
    if (expanded || rowHeight <= 0) {
      const count = expanded ? entryCount : Math.min(chipsPerDay, entryCount);
      return { count, showMore: !expanded && count < entryCount };
    }

    const available = rowHeight - ROW_FIXED_COST;
    // 只放事件时能容纳的条数
    const alone = Math.max(1, Math.floor((available + 8) / CHIP_SLOT));
    if (entryCount <= alone) return { count: Math.min(chipsPerDay, entryCount), showMore: false };

    // 再腾出「还有 N 项」的位置后还能容纳几条
    const withMore = Math.floor((available - MORE_COST) / CHIP_SLOT);
    if (withMore >= alone) {
      const count = Math.min(chipsPerDay, withMore);
      return { count, showMore: count < entryCount };
    }

    return { count: Math.min(chipsPerDay, alone), showMore: false };
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>, dayKey: string): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropTarget !== dayKey) setDropTarget(dayKey);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, day: Date): void => {
    event.preventDefault();
    setDropTarget(null);
    onDragStateChange?.(null);
    const id = event.dataTransfer.getData('text/plain');
    if (!id) return;
    const occurrence = occurrences.find((item) => item.id === id);
    if (!occurrence) return;
    if (occurrence.allDay) {
      const startKey = occurrence.startAt.slice(0, 10);
      if (startKey === toDateKey(day)) return;
    } else if (toDateKey(day) === toDateKey(new Date(occurrence.startAt))) {
      return;
    }
    onMoveToDay(occurrence, day);
  };

  return (
    <div className="month">
      <div className="month__weekdays" role="row">
        {WEEKDAY_SHORT.map((label, index) => (
          <div
            key={label}
            role="columnheader"
            className={cn('month__weekday', (index === 5 || index === 6) && 'is-weekend')}
          >
            周{label}
          </div>
        ))}
      </div>

      <div className="month__grid" role="grid" aria-label="月视图" ref={gridRef}>
        {days.map((day) => {
          const dayKey = toDateKey(day);
          const entries = buckets.get(dayKey) ?? [];
          const expanded = expandedDay === dayKey;
          const { count, showMore } = decide(entries.length, expanded);
          const visible: MonthEntry[] = expanded ? entries : entries.slice(0, count);
          const hiddenCount = entries.length - visible.length;
          const outside = day.getMonth() !== anchorMonth;

          return (
            <div
              key={dayKey}
              role="gridcell"
              aria-label={dayKey}
              tabIndex={-1}
              className={cn(
                'month__cell',
                outside && 'is-outside',
                isToday(day) && 'is-today',
                isWeekendDateKey(dayKey) && 'is-weekend',
                dropTarget === dayKey && 'is-drop-target',
              )}
              onClick={() => onOpenDay(day)}
              onDoubleClick={() => onCreateAllDay(day)}
              onDragOver={(event) => handleDragOver(event, dayKey)}
              onDragLeave={() => setDropTarget((current) => (current === dayKey ? null : current))}
              onDrop={(event) => handleDrop(event, day)}
            >
              <header className="month__cell-head">
                <span className="month__daynum numeric" aria-hidden="true">
                  {day.getDate()}
                </span>
                {entries.length > 0 && <span className="month__count">{entries.length} 项</span>}
              </header>

              <div className="month__events">
                {visible.map((entry) => (
                  <EventChip
                    key={`${dayKey}-${entry.occurrence.id}`}
                    occurrence={entry.occurrence}
                    color={eventColorOf(entry.occurrence, categoriesById)}
                    isDark={isDark}
                    selected={selectedId === entry.occurrence.id}
                    compact
                    draggable
                    showTime={entry.isStart || entry.occurrence.allDay}
                    onSelect={onSelect}
                    onDragEnd={() => {
                      setDropTarget(null);
                      onDragStateChange?.(null);
                    }}
                  />
                ))}

                {hiddenCount > 0 && showMore && (
                  <button
                    type="button"
                    className="month__more"
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpandedDay(dayKey);
                    }}
                  >
                    还有 {hiddenCount} 项
                  </button>
                )}

                {expanded && entries.length > chipsPerDay && (
                  <button
                    type="button"
                    className="month__more"
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpandedDay(null);
                    }}
                  >
                    收起
                  </button>
                )}

                {entries.length === 0 && (
                  <span className="month__day-hint" aria-hidden="true">
                    <Icon name="plus" size={12} /> 双击新建全天
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
