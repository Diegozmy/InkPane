/** 议程（列表）视图：按天分组，适合快速浏览一段时间内的全部安排。 */

import { useMemo, type ReactElement } from 'react';
import { cn } from '@/lib/cn';
import {
  formatTimeRange,
  formatDayLabel,
  parseOccurrenceEnd,
  parseOccurrenceStart,
  relativeDayLabel,
  toDateKey,
} from '@/lib/date';
import type { Category, Occurrence } from '@/types';
import { Badge } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icon';
import { categoryNameOf, eventColorOf, eventStyle, isOccurrencePast } from './calendar-utils';

export interface AgendaViewProps {
  days: Date[];
  occurrences: Occurrence[];
  categoriesById: Map<number, Category>;
  isDark: boolean;
  selectedId: string | null;
  onSelect: (occurrence: Occurrence) => void;
  onCreateAt: (day: Date) => void;
}

export function AgendaView({
  days,
  occurrences,
  categoriesById,
  isDark,
  selectedId,
  onSelect,
  onCreateAt,
}: AgendaViewProps): ReactElement {
  const grouped = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const day of days) map.set(toDateKey(day), []);
    for (const occurrence of occurrences) {
      const key = occurrence.allDay
        ? occurrence.startAt.slice(0, 10)
        : toDateKey(parseOccurrenceStart(occurrence));
      const bucket = map.get(key);
      if (bucket) bucket.push(occurrence);
      // 跨天落到区间外的实例不会出现在任何一桶里，直接忽略
    }
    return map;
  }, [days, occurrences]);

  const daysWithContent = days.filter((day) => (grouped.get(toDateKey(day)) ?? []).length > 0);

  return (
    <div className="agenda">
      {daysWithContent.length === 0 && (
        <div className="state-block">
          <span className="state-block__icon" aria-hidden="true">
            <Icon name="list-bullets" size={26} />
          </span>
          <h3 className="state-block__title">这段时间还没有安排</h3>
          <p className="state-block__description">
            调整右侧的筛选条件，或直接新建一条日程来占位。
          </p>
        </div>
      )}

      {daysWithContent.map((day) => {
        const key = toDateKey(day);
        const items = [...(grouped.get(key) ?? [])].sort((a, b) => {
          if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
          if (a.allDay) return a.title.localeCompare(b.title, 'zh-Hans-CN');
          return parseOccurrenceStart(a).getTime() - parseOccurrenceStart(b).getTime();
        });

        return (
          <section className="agenda__day" key={key} aria-labelledby={`agenda-${key}`}>
            <header className="agenda__head">
              <h2 className="agenda__date" id={`agenda-${key}`}>
                {formatDayLabel(day)}
              </h2>
              <span className="agenda__weekday">{relativeDayLabel(day)}</span>
              <span className="agenda__count">{items.length} 项</span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => onCreateAt(day)}
              >
                <Icon name="plus" size={14} />
                <span className="btn__label">添加</span>
              </button>
            </header>

            <ul className="agenda__list">
              {items.map((occurrence) => {
                const color = eventColorOf(occurrence, categoriesById);
                const timeLabel = occurrence.allDay
                  ? '全天'
                  : formatTimeRange(parseOccurrenceStart(occurrence), parseOccurrenceEnd(occurrence));

                return (
                  <li key={occurrence.id}>
                    <button
                      type="button"
                      className={cn(
                        'agenda__item',
                        selectedId === occurrence.id && 'is-selected',
                        occurrence.status === 'cancelled' && 'is-cancelled',
                      )}
                      style={eventStyle(color, isDark)}
                      onClick={() => onSelect(occurrence)}
                    >
                      <span className={cn('agenda__time', occurrence.allDay && 'agenda__time--allday')}>
                        {timeLabel}
                      </span>

                      <span className="agenda__body">
                        <span className="agenda__title">{occurrence.title}</span>
                        <span className="agenda__meta">
                          <span className="agenda__meta-item">
                            <Icon name="tag" size={12} />
                            {categoryNameOf(occurrence, categoriesById)}
                          </span>
                          {occurrence.location && (
                            <span className="agenda__meta-item truncate">
                              <Icon name="map-pin" size={12} />
                              {occurrence.location}
                            </span>
                          )}
                          {occurrence.isRecurring && (
                            <span className="agenda__meta-item">
                              <Icon name="repeat" size={12} />
                              重复
                            </span>
                          )}
                        </span>
                      </span>

                      <span className="agenda__side">
                        {occurrence.priority !== 'normal' && (
                          <Badge
                            tone={
                              occurrence.priority === 'urgent'
                                ? 'danger'
                                : occurrence.priority === 'high'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {occurrence.priority === 'urgent'
                              ? '紧急'
                              : occurrence.priority === 'high'
                                ? '高'
                                : '低'}
                          </Badge>
                        )}
                        {occurrence.isModified && <Badge tone="accent">已调整</Badge>}
                        {isOccurrencePast(occurrence) && <Badge>已过期</Badge>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
