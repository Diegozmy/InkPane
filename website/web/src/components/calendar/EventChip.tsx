/** 事件块：月视图的紧凑条目与时间网格/全天条共用的展示单元。 */

import type { CSSProperties, DragEvent, KeyboardEvent, ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { formatTime, parseOccurrenceStart } from '@/lib/date';
import type { Occurrence } from '@/types';
import { Icon } from '@/components/ui/icon';
import { eventStyle, isOccurrencePast } from './calendar-utils';

export interface EventChipProps {
  occurrence: Occurrence;
  color: string;
  isDark: boolean;
  selected?: boolean;
  /** 是否显示时间前缀，全天事件与紧凑模式不显示 */
  showTime?: boolean;
  compact?: boolean;
  variant?: 'soft' | 'solid';
  draggable?: boolean;
  past?: boolean;
  onSelect: (occurrence: Occurrence) => void;
  onDragStart?: (occurrence: Occurrence) => void;
  onDragEnd?: () => void;
  className?: string;
  style?: CSSProperties;
  /** 供无障碍朗读与提示使用的完整描述 */
  ariaLabel?: string;
}

export function EventChip({
  occurrence,
  color,
  isDark,
  selected = false,
  showTime = true,
  compact = false,
  variant = 'soft',
  draggable = false,
  past,
  onSelect,
  onDragStart,
  onDragEnd,
  className,
  style,
  ariaLabel,
}: EventChipProps): ReactElement {
  const start = parseOccurrenceStart(occurrence);
  const isPast = past ?? isOccurrencePast(occurrence);
  const label =
    ariaLabel ??
    `${occurrence.allDay ? '全天' : formatTime(start)} ${occurrence.title}${occurrence.isRecurring ? '（重复）' : ''}`;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(occurrence);
    }
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>): void => {
    event.dataTransfer.setData('text/plain', occurrence.id);
    event.dataTransfer.effectAllowed = 'move';
    onDragStart?.(occurrence);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      draggable={draggable}
      className={cn(
        'event-chip',
        compact && 'event-chip--month',
        selected && 'is-selected',
        isPast && 'is-past',
        occurrence.status === 'cancelled' && 'is-cancelled',
        className,
      )}
      style={{ ...eventStyle(color, isDark, variant), ...style }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(occurrence);
      }}
      onKeyDown={handleKeyDown}
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
    >
      {variant === 'solid' ? (
        showTime && !occurrence.allDay && <span className="event-chip__time">{formatTime(start)}</span>
      ) : showTime && !occurrence.allDay ? (
        <span className="event-chip__time">{formatTime(start)}</span>
      ) : (
        !occurrence.allDay && compact && <span className="event-chip__dot" aria-hidden="true" />
      )}
      <span className="event-chip__title">{occurrence.title}</span>
      {(occurrence.isRecurring || occurrence.remindMinutesBefore !== null) && !compact && (
        <span className="event-chip__icons" aria-hidden="true">
          {occurrence.isRecurring && <Icon name="repeat" size={11} />}
          {occurrence.remindMinutesBefore !== null && <Icon name="bell" size={11} />}
        </span>
      )}
    </div>
  );
}

/** 全天事件条：实底填充，文字色按背景亮度自动取深墨或白字，保证对比度达标。 */
export function AllDayChip({
  occurrence,
  color,
  isDark,
  selected,
  onSelect,
  className,
  style,
}: {
  occurrence: Occurrence;
  color: string;
  isDark: boolean;
  selected?: boolean;
  onSelect: (occurrence: Occurrence) => void;
  className?: string;
  style?: CSSProperties;
}): ReactElement {
  const startKey = occurrence.startAt.slice(0, 10);
  const endKey = occurrence.endAt.slice(0, 10);
  const multiDay = startKey !== endKey;

  return (
    <EventChip
      occurrence={occurrence}
      color={color}
      isDark={isDark}
      selected={selected}
      variant="solid"
      showTime={false}
      compact
      onSelect={onSelect}
      className={cn('event-chip--allday', className)}
      style={style}
      ariaLabel={`全天 ${occurrence.title}${multiDay ? `（${startKey} 至 ${endKey}）` : ''}`}
    />
  );
}

/** 议程视图右侧的重复/提醒标记，避免在紧凑行里堆图标。 */
export function OccurrenceMarkers({ occurrence }: { occurrence: Occurrence }): ReactElement | null {
  if (!occurrence.isRecurring && occurrence.remindMinutesBefore === null) return null;
  return (
    <span className="row" style={{ gap: 4 }}>
      {occurrence.isRecurring && (
        <span className="badge" title="重复日程">
          <Icon name="repeat" size={11} />
          重复
        </span>
      )}
      {occurrence.remindMinutesBefore !== null && (
        <span className="badge" title={`提前 ${occurrence.remindMinutesBefore} 分钟提醒`}>
          <Icon name="bell" size={11} />
          提醒
        </span>
      )}
    </span>
  );
}
