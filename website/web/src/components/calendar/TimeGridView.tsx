/**
 * 时间网格（周视图 / 日视图）。
 *
 * 交互全部基于 Pointer Events 手写实现，不引入拖拽库：
 *  - 在空白处按下并拖动 = 新建日程（15 分钟吸附）
 *  - 按住事件块拖动 = 改期（可跨天）
 *  - 拖动事件块底边 = 调整时长
 *  - Esc = 放弃本次拖拽
 * 拖拽过程只更新本地预览，松手才写库，因此不会产生中间态脏数据。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { cn } from '@/lib/cn';
import {
  DAY_MINUTES,
  MIN_EVENT_MINUTES,
  WEEKDAY_LONG,
  clampMinutes,
  formatTime,
  isToday,
  isWeekend,
  minutesFromMidnight,
  parseOccurrenceEnd,
  parseOccurrenceStart,
  snapMinutes,
  toDateKey,
} from '@/lib/date';
import { useIsCompact } from '@/hooks/use-theme';
import type { Category, Occurrence } from '@/types';
import { AllDayChip } from './EventChip';
import {
  blockPositionStyle,
  buildMonthBuckets,
  eventColorOf,
  eventStyle,
  isOccurrencePast,
  layoutTimedEvents,
} from './calendar-utils';

export interface TimeGridViewProps {
  days: Date[];
  occurrences: Occurrence[];
  categoriesById: Map<number, Category>;
  isDark: boolean;
  selectedId: string | null;
  onSelect: (occurrence: Occurrence) => void;
  onOpenDay: (day: Date) => void;
  onCreateRange: (day: Date, startMinutes: number, endMinutes: number) => void;
  onMoveRange: (occurrence: Occurrence, day: Date, startMinutes: number, endMinutes: number) => void;
}

type DragState =
  | { kind: 'create'; dayIndex: number; anchorMinutes: number; startMinutes: number; endMinutes: number }
  | {
      kind: 'move';
      dayIndex: number;
      occurrence: Occurrence;
      durationMinutes: number;
      grabOffsetMinutes: number;
      startMinutes: number;
      endMinutes: number;
    }
  | { kind: 'resize'; dayIndex: number; occurrence: Occurrence; startMinutes: number; endMinutes: number };

const HOURS = Array.from({ length: 24 }, (_, index) => index);

export function TimeGridView({
  days,
  occurrences,
  categoriesById,
  isDark,
  selectedId,
  onSelect,
  onOpenDay,
  onCreateRange,
  onMoveRange,
}: TimeGridViewProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const colsRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const daysRef = useRef(days);
  const [now, setNow] = useState(() => new Date());
  /** 时间轴滚动条宽度，供表头与全天行对齐使用 */
  const [scrollbarGutter, setScrollbarGutter] = useState(0);
  const compact = useIsCompact();

  const dayCount = days.length;
  const buckets = useMemo(() => buildMonthBuckets(occurrences, days), [occurrences, days]);
  const isDragging = drag !== null;

  daysRef.current = days;
  dragRef.current = drag;

  /* 每分钟刷新一次“当前时间”指示线 */
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /* 初次进入滚动到早上 7 点附近，这是最常查看的时段 */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const columnHeight = colsRef.current?.getBoundingClientRect().height ?? 0;
    if (columnHeight > 0) element.scrollTop = (columnHeight / 24) * 7;
  }, [dayCount]);

  /* 实测滚动条宽度：表头与全天行据此留出同样的右侧空间才能与列对齐 */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    const measure = (): void => setScrollbarGutter(element.offsetWidth - element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [dayCount]);

  const minutesFromPointer = useCallback((clientY: number): number => {
    const rect = colsRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return 0;
    const offsetY = Math.max(0, Math.min(rect.height, clientY - rect.top));
    return clampMinutes((offsetY / rect.height) * DAY_MINUTES);
  }, []);

  const dayIndexFromPointer = useCallback((clientX: number): number => {
    const rect = colsRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(daysRef.current.length - 1, Math.floor(ratio * daysRef.current.length)));
  }, []);

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>, next: DragState) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = next;
    setDrag(next);
  }, []);

  /* 拖拽期间在 window 上监听，保证指针移出网格甚至移出窗口也不丢事件 */
  useEffect(() => {
    if (!isDragging) return undefined;

    const onMove = (event: PointerEvent): void => {
      const current = dragRef.current;
      if (!current) return;
      const minutes = minutesFromPointer(event.clientY);
      const dayIndex = dayIndexFromPointer(event.clientX);
      let next: DragState;

      if (current.kind === 'create') {
        const start = Math.min(current.anchorMinutes, minutes);
        const end = Math.max(current.anchorMinutes, minutes);
        next = {
          ...current,
          dayIndex,
          startMinutes: clampMinutes(start),
          endMinutes: clampMinutes(Math.max(end, start + MIN_EVENT_MINUTES)),
        };
      } else if (current.kind === 'move') {
        const start = clampMinutes(minutes - current.grabOffsetMinutes);
        next = { ...current, dayIndex, startMinutes: start, endMinutes: clampMinutes(start + current.durationMinutes) };
      } else {
        next = {
          ...current,
          endMinutes: clampMinutes(Math.max(minutes, current.startMinutes + MIN_EVENT_MINUTES)),
        };
      }

      dragRef.current = next;
      setDrag(next);
    };

    const finish = (commit: boolean): void => {
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!commit || !current) return;

      const day = daysRef.current[current.dayIndex];
      if (!day) return;

      if (current.kind === 'create') {
        const start = snapMinutes(current.startMinutes);
        const end = Math.max(start + MIN_EVENT_MINUTES, snapMinutes(current.endMinutes));
        onCreateRange(day, start, Math.min(DAY_MINUTES, end));
        return;
      }

      const start = snapMinutes(current.startMinutes);
      const end = Math.max(start + MIN_EVENT_MINUTES, snapMinutes(current.endMinutes));
      onMoveRange(current.occurrence, day, start, Math.min(DAY_MINUTES, end));
    };

    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isDragging, dayIndexFromPointer, minutesFromPointer, onCreateRange, onMoveRange]);

  /* ---------------------------- 指针入口 ---------------------------- */

  const onColumnPointerDown = (event: ReactPointerEvent<HTMLDivElement>, dayIndex: number): void => {
    if (event.target !== event.currentTarget) return;
    const minutes = snapMinutes(minutesFromPointer(event.clientY));
    beginDrag(event, {
      kind: 'create',
      dayIndex,
      anchorMinutes: minutes,
      startMinutes: minutes,
      endMinutes: clampMinutes(minutes + MIN_EVENT_MINUTES),
    });
  };

  const onBlockPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    occurrence: Occurrence,
    positioned: { startMinutes: number; endMinutes: number },
    dayIndex: number,
  ): void => {
    event.stopPropagation();
    const minutes = minutesFromPointer(event.clientY);
    beginDrag(event, {
      kind: 'move',
      dayIndex,
      occurrence,
      durationMinutes: Math.max(MIN_EVENT_MINUTES, positioned.endMinutes - positioned.startMinutes),
      grabOffsetMinutes: minutes - positioned.startMinutes,
      startMinutes: positioned.startMinutes,
      endMinutes: positioned.endMinutes,
    });
  };

  const onResizePointerDown = (
    event: ReactPointerEvent<HTMLSpanElement>,
    occurrence: Occurrence,
    positioned: { startMinutes: number; endMinutes: number },
    dayIndex: number,
  ): void => {
    event.stopPropagation();
    beginDrag(event, {
      kind: 'resize',
      dayIndex,
      occurrence,
      startMinutes: positioned.startMinutes,
      endMinutes: positioned.endMinutes,
    });
  };

  const nowMinutes = minutesFromMidnight(now);
  const gridStyle = {
    '--day-count': dayCount,
    '--scrollbar-gutter': `${scrollbarGutter}px`,
  } as CSSProperties;

  return (
    <div className="timegrid" style={gridStyle}>
      <div className="timegrid__head">
        <div className="timegrid__gutter" />
        {days.map((day) => (
          <div
            key={toDateKey(day)}
            className={cn('timegrid__day-head', isToday(day) && 'is-today', isWeekend(day) && 'is-weekend')}
            role="button"
            tabIndex={0}
            aria-label={`查看 ${toDateKey(day)}`}
            onClick={() => onOpenDay(day)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpenDay(day);
              }
            }}
          >
            <span className="timegrid__weekday">
              {dayCount === 1 ? '今天' : WEEKDAY_LONG[(day.getDay() + 6) % 7]}
            </span>
            <span className="timegrid__daynum numeric">{day.getDate()}</span>
          </div>
        ))}
      </div>

      <div className="timegrid__allday">
        <div className="timegrid__allday-label">全天</div>
        {days.map((day) => {
          const entries = (buckets.get(toDateKey(day)) ?? []).filter((entry) => entry.occurrence.allDay);
          return (
            <div
              key={`allday-${toDateKey(day)}`}
              className="timegrid__allday-col"
              onDoubleClick={() => onOpenDay(day)}
            >
              {entries.map((entry) => (
                <AllDayChip
                  key={`${toDateKey(day)}-${entry.occurrence.id}`}
                  occurrence={entry.occurrence}
                  color={eventColorOf(entry.occurrence, categoriesById)}
                  isDark={isDark}
                  selected={selectedId === entry.occurrence.id}
                  onSelect={onSelect}
                />
              ))}
            </div>
          );
        })}
      </div>

      <div className="timegrid__body" ref={scrollRef}>
        <div className="timegrid__gutter-col">
          {HOURS.map((hour) => (
            <div className="timegrid__hour-label numeric" key={hour}>
              {`${`${hour}`.padStart(2, '0')}:00`}
            </div>
          ))}
        </div>

        <div className="timegrid__cols" ref={colsRef}>
          {days.map((day, dayIndex) => {
            const positioned = layoutTimedEvents(occurrences, day);

            return (
              <div
                key={toDateKey(day)}
                className={cn('timegrid__col', isToday(day) && 'is-today', isWeekend(day) && 'is-weekend')}
              >
                <div className="timegrid__lines" aria-hidden="true">
                  {HOURS.map((hour) => (
                    <div className="timegrid__line" key={hour} />
                  ))}
                </div>

                <div
                  className="timegrid__events"
                  onPointerDown={(event) => onColumnPointerDown(event, dayIndex)}
                  onDoubleClick={(event) => {
                    if (event.target !== event.currentTarget) return;
                    const minutes = snapMinutes(minutesFromPointer(event.clientY));
                    onCreateRange(day, minutes, Math.min(DAY_MINUTES, minutes + 60));
                  }}
                >
                  {positioned.map((event) => {
                    const dragged =
                      drag !== null &&
                      drag.kind !== 'create' &&
                      drag.occurrence.id === event.occurrence.id;
                    const color = eventColorOf(event.occurrence, categoriesById);
                    const duration = event.endMinutes - event.startMinutes;

                    const style = dragged
                      ? {
                          ...eventStyle(color, isDark),
                          ...blockPositionStyle({
                            ...event,
                            startMinutes: drag.startMinutes,
                            endMinutes: drag.endMinutes,
                          }),
                        }
                      : { ...eventStyle(color, isDark), ...blockPositionStyle(event) };

                    return (
                      <div
                        key={event.occurrence.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`${formatTime(parseOccurrenceStart(event.occurrence))} ${event.occurrence.title}`}
                        className={cn(
                          'event-block',
                          duration < 40 && 'event-block--compact',
                          selectedId === event.occurrence.id && 'is-selected',
                          isOccurrencePast(event.occurrence, now) && 'is-past',
                          event.occurrence.status === 'cancelled' && 'is-cancelled',
                          dragged && 'is-dragging',
                        )}
                        style={style}
                        onPointerDown={(pointerEvent) =>
                          onBlockPointerDown(pointerEvent, event.occurrence, event, dayIndex)
                        }
                        onKeyDown={(keyEvent) => {
                          if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
                            keyEvent.preventDefault();
                            onSelect(event.occurrence);
                          }
                        }}
                        onDoubleClick={() => onSelect(event.occurrence)}
                      >
                        {duration >= 40 && (
                          <span className="event-block__time numeric">
                            {formatTime(parseOccurrenceStart(event.occurrence))}
                            {duration >= 60 && ` - ${formatTime(parseOccurrenceEnd(event.occurrence))}`}
                          </span>
                        )}
                        <span className="event-block__title">{event.occurrence.title}</span>
                        <span
                          className="event-block__resize"
                          role="separator"
                          aria-label="调整时长"
                          onPointerDown={(pointerEvent) =>
                            onResizePointerDown(pointerEvent, event.occurrence, event, dayIndex)
                          }
                        />
                      </div>
                    );
                  })}

                  {drag?.kind === 'create' && drag.dayIndex === dayIndex && (
                    <div
                      className="timegrid__preview"
                      style={{
                        top: `calc(var(--minute-height) * ${drag.startMinutes})`,
                        height: `calc(var(--minute-height) * ${Math.max(
                          MIN_EVENT_MINUTES,
                          drag.endMinutes - drag.startMinutes,
                        )} - 2px)`,
                      }}
                    >
                      <span className="timegrid__preview-label numeric">
                        {formatTime(
                          new Date(2020, 0, 1, Math.floor(drag.startMinutes / 60), drag.startMinutes % 60),
                        )}
                        {' - '}
                        {formatTime(
                          new Date(2020, 0, 1, Math.floor(drag.endMinutes / 60), drag.endMinutes % 60),
                        )}
                      </span>
                    </div>
                  )}

                  {isToday(day) && (
                    <div className="timegrid__now" style={{ top: `calc(var(--minute-height) * ${nowMinutes})` }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {compact && dayCount > 1 && (
        <p className="timegrid__hint">
          在空白处上下拖动可新建日程，拖动事件块可改期，拖动底边可调整时长。
        </p>
      )}
    </div>
  );
}
