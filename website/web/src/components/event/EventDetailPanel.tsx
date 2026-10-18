/** 日程详情面板（右侧滑出）：完整信息 + 编辑 / 重置 / 删除。 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { useCategories } from '@/api/use-calendar-data';
import { useCancelOccurrence, useDeleteEvent, useResetOverride } from '@/api/use-calendar-mutations';
import { formatDayLabel, formatDuration, formatTimeRange, parseOccurrenceEnd, parseOccurrenceStart } from '@/lib/date';
import { describeRecurrence, describeReminder } from '@/lib/recurrence-text';
import { useUiStore } from '@/store/ui-store';
import { useIsCompact } from '@/hooks/use-theme';
import { Icon } from '@/components/ui/icon';
import { Badge, Button, Chip, DetailRow, IconButton } from '@/components/ui';
import { categoryNameOf, eventColorOf, eventStyle } from '@/components/calendar/calendar-utils';
import { PRIORITY_META, STATUS_META } from '@/lib/constants';
import { EventDeleteDialog, type DeleteScope } from './EventDeleteDialog';

export function EventDetailPanel(): ReactElement | null {
  const occurrence = useUiStore((state) => state.detailsOccurrence);
  const setDetailsOccurrence = useUiStore((state) => state.setDetailsOccurrence);
  const openEditEditor = useUiStore((state) => state.openEditEditor);
  const isDark = useUiStore((state) => state.resolvedTheme === 'dark');

  const { data: categories } = useCategories();
  const deleteEvent = useDeleteEvent();
  const cancelOccurrence = useCancelOccurrence();
  const resetOverride = useResetOverride();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const compact = useIsCompact();

  const categoriesById = useMemo(
    () => new Map((categories ?? []).map((category) => [category.id, category])),
    [categories],
  );

  /* 移动端面板铺满下半屏，需锁定背景滚动 */
  useEffect(() => {
    if (!occurrence || !compact) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [occurrence, compact]);

  useEffect(() => {
    setDeleteOpen(false);
  }, [occurrence?.id]);

  if (!occurrence) return null;

  const start = parseOccurrenceStart(occurrence);
  const end = parseOccurrenceEnd(occurrence);
  const color = eventColorOf(occurrence, categoriesById);
  const durationMinutes = occurrence.allDay
    ? null
    : Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));

  const busy = deleteEvent.isPending || cancelOccurrence.isPending || resetOverride.isPending;

  return (
    <>
      <div className="detail-backdrop" role="presentation" onClick={() => setDetailsOccurrence(null)} />
      <aside
        className="detail-panel"
        style={eventStyle(color, isDark)}
        aria-label={`日程详情：${occurrence.title}`}
      >
        <header className="detail-panel__header">
          <div className="row" style={{ alignItems: 'flex-start', minWidth: 0 }}>
            <span className="detail-panel__accent" aria-hidden="true" />
            <div style={{ minWidth: 0 }}>
              <h2 className="detail-panel__title">{occurrence.title}</h2>
              <div className="detail-panel__tags">
                <Badge tone="neutral" icon="tag">
                  {categoryNameOf(occurrence, categoriesById)}
                </Badge>
                {occurrence.priority !== 'normal' && (
                  <Badge tone={PRIORITY_META[occurrence.priority].tone}>
                    {PRIORITY_META[occurrence.priority].label}优先级
                  </Badge>
                )}
                {occurrence.status !== 'confirmed' && (
                  <Badge tone={occurrence.status === 'cancelled' ? 'danger' : 'warning'}>
                    {STATUS_META[occurrence.status].label}
                  </Badge>
                )}
                {occurrence.isModified && <Badge tone="accent">本次已单独调整</Badge>}
                {occurrence.isRecurring && <Badge icon="repeat">重复日程</Badge>}
              </div>
            </div>
          </div>
          <IconButton icon="close" label="关闭详情" onClick={() => setDetailsOccurrence(null)} />
        </header>

        <div className="detail-panel__body">
          <div className="detail-section">
            <DetailRow icon="clock" label="时间">
              {occurrence.allDay ? (
                <span>
                  全天 · {formatDayLabel(start, true)}
                  {occurrence.startAt.slice(0, 10) !== occurrence.endAt.slice(0, 10) &&
                    ` 至 ${formatDayLabel(end, true)}`}
                </span>
              ) : (
                <span className="numeric">
                  {formatDayLabel(start, true)} {formatTimeRange(start, end)}
                  {durationMinutes !== null && durationMinutes > 0 && (
                    <span className="muted">（{formatDuration(durationMinutes)}）</span>
                  )}
                </span>
              )}
            </DetailRow>

            {occurrence.location && (
              <DetailRow icon="map-pin" label="地点">
                {occurrence.location}
              </DetailRow>
            )}

            {occurrence.isRecurring && (
              <DetailRow icon="repeat" label="重复">
                {describeRecurrence(occurrence.rrule)}
              </DetailRow>
            )}

            <DetailRow icon="bell" label="提醒">
              {describeReminder(occurrence.remindMinutesBefore)}
            </DetailRow>

            <DetailRow icon="flag" label="时区">
              {occurrence.timezone}
            </DetailRow>
          </div>

          {occurrence.description.trim().length > 0 && (
            <div className="detail-section">
              <span className="section-title">备注</span>
              <p className="detail-panel__description">{occurrence.description}</p>
            </div>
          )}

          {occurrence.tags.length > 0 && (
            <div className="detail-section">
              <span className="section-title">标签</span>
              <div className="row row--wrap">
                {occurrence.tags.map((tag) => (
                  <Chip key={tag}>{tag}</Chip>
                ))}
              </div>
            </div>
          )}

          {occurrence.isRecurring && (
            <div className={cn('alert', 'alert--info')}>
              <span className="alert__icon" aria-hidden="true">
                <Icon name="info" size={16} />
              </span>
              <div className="alert__body">
                <p className="alert__content">
                  这是重复日程的一个实例。编辑时可以选择只改这一次，或调整整条序列。
                </p>
              </div>
            </div>
          )}
        </div>

        <footer className="detail-panel__footer">
          {occurrence.isModified && (
            <Button
              variant="ghost"
              size="sm"
              leadingIcon="refresh"
              disabled={busy}
              onClick={() =>
                resetOverride.mutate({
                  eventId: occurrence.eventId,
                  occurrenceKey: occurrence.occurrenceKey,
                })
              }
            >
              恢复默认
            </Button>
          )}
          <div className="grow" />
          <Button
            variant="ghost"
            size="sm"
            leadingIcon="trash"
            disabled={busy}
            style={{ color: 'var(--danger)' }}
            onClick={() => setDeleteOpen(true)}
          >
            删除
          </Button>
          <Button
            variant="primary"
            size="sm"
            leadingIcon="pencil"
            disabled={busy}
            onClick={() => openEditEditor(occurrence)}
          >
            编辑
          </Button>
        </footer>
      </aside>

      <EventDeleteDialog
        open={deleteOpen}
        occurrence={occurrence}
        busy={busy}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={({ scope, occurrenceKey }: { scope: DeleteScope; occurrenceKey: string }) => {
          setDeleteOpen(false);
          const finish = { onSuccess: () => setDetailsOccurrence(null) };
          if (scope === 'series') {
            deleteEvent.mutate(occurrence.eventId, finish);
          } else {
            cancelOccurrence.mutate(
              { eventId: occurrence.eventId, occurrenceKey, scope: scope === 'future' ? 'future' : 'single' },
              finish,
            );
          }
        }}
      />
    </>
  );
}
