/** 侧栏小月历：快速跳转日期，并在有安排的日期上打点。 */

import { useMemo, type ReactElement } from 'react';
import { cn } from '@/lib/cn';
import {
  WEEKDAY_SHORT,
  addMonths,
  formatMonthTitle,
  fromDateKey,
  isSameDate,
  isSameMonth,
  isToday,
  toDateKey,
} from '@/lib/date';
import { IconButton } from '@/components/ui/primitives';

export interface MiniMonthProps {
  /** 决定显示哪个月份 */
  anchor: Date;
  /** 高亮选中的日期 */
  selected: Date;
  /** 有安排的日期集合（YYYY-MM-DD） */
  markedDays: ReadonlySet<string>;
  onChangeMonth: (date: Date) => void;
  onSelectDay: (date: Date) => void;
}

export function MiniMonth({
  anchor,
  selected,
  markedDays,
  onChangeMonth,
  onSelectDay,
}: MiniMonthProps): ReactElement {
  const cells = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const weekdayOffset = (first.getDay() + 6) % 7; // 周一为 0
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - weekdayOffset);

    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const totalDays = weekdayOffset + last.getDate();
    const rows = Math.ceil(totalDays / 7);

    return Array.from({ length: rows * 7 }, (_, index) => {
      const date = new Date(gridStart);
      date.setDate(gridStart.getDate() + index);
      return date;
    });
  }, [anchor]);

  return (
    <div className="mini-month">
      <div className="mini-month__head">
        <span className="mini-month__title">{formatMonthTitle(anchor)}</span>
        <div className="row">
          <IconButton
            icon="caret-left"
            label="上一个月"
            size="sm"
            onClick={() => onChangeMonth(addMonths(anchor, -1))}
          />
          <IconButton
            icon="caret-right"
            label="下一个月"
            size="sm"
            onClick={() => onChangeMonth(addMonths(anchor, 1))}
          />
        </div>
      </div>

      <div className="mini-month__grid" role="grid" aria-label="小月历">
        {WEEKDAY_SHORT.map((label) => (
          <div key={label} className="mini-month__weekday" role="columnheader">
            {label}
          </div>
        ))}

        {cells.map((date) => {
          const key = toDateKey(date);
          const outside = !isSameMonth(date, anchor);
          const marked = markedDays.has(key);
          return (
            <button
              key={key}
              type="button"
              role="gridcell"
              aria-label={key}
              aria-current={isToday(date) ? 'date' : undefined}
              className={cn(
                'mini-month__day',
                outside && 'is-outside',
                isToday(date) && 'is-today',
                isSameDate(date, selected) && 'is-anchor',
              )}
              onClick={() => onSelectDay(fromDateKey(key))}
            >
              {date.getDate()}
              {marked && <span className="mini-month__dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
