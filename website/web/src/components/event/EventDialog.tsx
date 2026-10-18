/**
 * 日程编辑弹窗。
 *
 * 关键设计：编辑重复日程时，先让用户明确「改这一次」还是「改整条序列」，
 * 因为两者的后端语义完全不同（实例覆盖 vs 平移主序列），含糊处理会导致数据意外被批量修改。
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { useCategories, useEventMaster } from '@/api/use-calendar-data';
import {
  useCreateEvent,
  useCancelOccurrence,
  useDeleteEvent,
  useOverrideOccurrence,
  useUpdateEvent,
} from '@/api/use-calendar-mutations';
import {
  DURATION_OPTIONS,
  FREQUENCY_OPTIONS,
  PRESET_COLORS,
  REMINDER_OPTIONS,
  WEEKDAY_OPTIONS,
} from '@/lib/constants';
import { useUiStore } from '@/store/ui-store';
import { Icon } from '@/components/ui/icon';
import {
  Badge,
  Button,
  Chip,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from '@/components/ui';
import {
  addMinutesToTime,
  buildEventPayload,
  createEmptyFormState,
  formStateFromOccurrence,
  shiftSeriesTimes,
  type EditScope,
  type EventFormState,
} from './form-state';
import { EventDeleteDialog } from './EventDeleteDialog';

export function EventDialog(): ReactElement | null {
  const editor = useUiStore((state) => state.editor);
  const closeEditor = useUiStore((state) => state.closeEditor);

  const occurrence = editor?.mode === 'edit' ? editor.occurrence : null;
  const isRecurring = occurrence?.isRecurring ?? false;

  const { data: categories } = useCategories();
  const { data: master } = useEventMaster(occurrence?.eventId ?? null, isRecurring);

  const createEvent = useCreateEvent();
  const updateEvent = useUpdateEvent();
  const overrideOccurrence = useOverrideOccurrence();
  const deleteEvent = useDeleteEvent();
  const cancelOccurrence = useCancelOccurrence();

  const [state, setState] = useState<EventFormState | null>(null);
  const [scope, setScope] = useState<EditScope>('single');
  const [error, setError] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const initializedKeyRef = useRef<string | null>(null);

  const editorKey = useMemo(() => {
    if (!editor) return null;
    return editor.mode === 'create'
      ? `create:${editor.defaults.startAt}:${editor.defaults.endAt}`
      : `edit:${editor.occurrence.id}`;
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      initializedKeyRef.current = null;
      setState(null);
      setError(null);
      setTagDraft('');
      return;
    }
    // 同一目标只初始化一次，避免主记录到达后覆盖用户已经输入的内容
    if (initializedKeyRef.current === editorKey) return;

    if (editor.mode === 'create') {
      setState(createEmptyFormState(editor.defaults));
      setScope('single');
      setError(null);
      initializedKeyRef.current = editorKey;
      return;
    }
    // 重复日程需要主记录才能正确计算「整个序列」的时间平移
    if (editor.occurrence.isRecurring && !master) return;
    setState(formStateFromOccurrence(editor.occurrence, master ?? null));
    setScope('single');
    setError(null);
    initializedKeyRef.current = editorKey;
  }, [editor, editorKey, master]);

  // 注意：所有 hook 都必须在这个提前返回之前调用，
  // 否则 editor 从 null 变为有值时会触发「Rendered more hooks than during the previous render」。
  const durationLabel = useMemo(() => {
    if (!state || state.allDay) return null;
    const start = new Date(`${state.startDate}T${state.startTime}`);
    const end = new Date(`${state.endDate}T${state.endTime}`);
    const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
  }, [state]);

  if (!editor) return null;

  const busy =
    createEvent.isPending ||
    updateEvent.isPending ||
    overrideOccurrence.isPending ||
    deleteEvent.isPending ||
    cancelOccurrence.isPending;

  const patch = (next: Partial<EventFormState>): void => {
    setState((current) => (current ? { ...current, ...next } : current));
  };

  const handleSubmit = (): void => {
    if (!state) return;
    const { payload, error: validationError } = buildEventPayload(state);
    if (!payload || validationError) {
      setError(validationError);
      return;
    }
    setError(null);

    if (editor.mode === 'create') {
      createEvent.mutate(payload, { onSuccess: () => closeEditor() });
      return;
    }

    const target = editor.occurrence;

    if (!target.isRecurring || scope === 'all') {
      if (target.isRecurring && master) {
        const shifted = shiftSeriesTimes(master, target, payload);
        updateEvent.mutate(
          {
            id: target.eventId,
            payload: { ...payload, startAt: shifted.startAt, endAt: shifted.endAt },
          },
          { onSuccess: () => closeEditor() },
        );
        return;
      }
      updateEvent.mutate(
        { id: target.eventId, payload },
        { onSuccess: () => closeEditor() },
      );
      return;
    }

    overrideOccurrence.mutate(
      {
        eventId: target.eventId,
        payload: {
          occurrenceKey: target.occurrenceKey,
          title: payload.title,
          description: payload.description ?? '',
          location: payload.location ?? '',
          priority: payload.priority,
          categoryId: payload.categoryId ?? null,
          allDay: payload.allDay ?? false,
          startAt: payload.startAt,
          endAt: payload.endAt,
          tags: payload.tags ?? [],
        },
      },
      { onSuccess: () => closeEditor() },
    );
  };

  const addTag = (): void => {
    const value = tagDraft.trim();
    if (value.length === 0 || !state) return;
    if (state.tags.includes(value) || state.tags.length >= 20) {
      setTagDraft('');
      return;
    }
    patch({ tags: [...state.tags, value] });
    setTagDraft('');
  };

  const title = editor.mode === 'create' ? '新建日程' : '编辑日程';

  return (
    <>
      <Modal
        open
        onClose={closeEditor}
        title={title}
        description={
          editor.mode === 'edit' && editor.occurrence.isRecurring
            ? '这是一条重复日程，请选择修改范围。'
            : undefined
        }
        size="lg"
        dismissOnBackdrop={false}
        footer={
          <>
            {editor.mode === 'edit' && (
              <Button
                variant="ghost"
                leadingIcon="trash"
                onClick={() => setDeleteOpen(true)}
                style={{ marginRight: 'auto', color: 'var(--danger)' }}
              >
                删除
              </Button>
            )}
            <Button onClick={closeEditor} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" onClick={handleSubmit} loading={busy} leadingIcon="check">
              保存
            </Button>
          </>
        }
      >
        {!state ? (
          <div className="stack">
            <Skeleton height={36} radius="var(--radius-control)" />
            <Skeleton height={36} radius="var(--radius-control)" />
            <Skeleton height={120} radius="var(--radius-control)" />
          </div>
        ) : (
          <div className="stack stack--lg">
            {error && (
              <div className="alert alert--danger" role="alert">
                <span className="alert__icon" aria-hidden="true">
                  <Icon name="warning-circle" size={16} />
                </span>
                <div className="alert__body">
                  <p className="alert__title">{error}</p>
                </div>
              </div>
            )}

            {editor.mode === 'edit' && editor.occurrence.isRecurring && (
              <Field
                label="修改范围"
                hint={
                  scope === 'single'
                    ? '只影响当前这一次，序列中其他时间保持不变。'
                    : '会同时调整整条重复序列的内容与时间。'
                }
              >
                <SegmentedControl
                  value={scope}
                  onChange={(value) => setScope(value)}
                  ariaLabel="修改范围"
                  options={[
                    { value: 'single', label: '仅此一次', icon: 'calendar-check' },
                    { value: 'all', label: '整个序列', icon: 'repeat' },
                  ]}
                />
              </Field>
            )}

            <Field label="标题" required>
              <Input
                value={state.title}
                autoFocus
                maxLength={120}
                placeholder="例如：产品评审会"
                onChange={(event) => patch({ title: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    handleSubmit();
                  }
                }}
              />
            </Field>

            <div className="form-grid">
              <Field label="分类">
                <Select
                  value={state.categoryId === null ? '' : String(state.categoryId)}
                  onChange={(event) =>
                    patch({ categoryId: event.target.value === '' ? null : Number(event.target.value) })
                  }
                >
                  <option value="">未分类</option>
                  {(categories ?? []).map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="优先级">
                <SegmentedControl
                  value={state.priority}
                  onChange={(value) => patch({ priority: value })}
                  ariaLabel="优先级"
                  options={[
                    { value: 'low', label: '低' },
                    { value: 'normal', label: '普通' },
                    { value: 'high', label: '高' },
                    { value: 'urgent', label: '紧急' },
                  ]}
                />
              </Field>

              <Field label="地点" className="form-grid__full">
                <Input
                  value={state.location}
                  maxLength={200}
                  placeholder="会议室 / 线上链接 / 地址"
                  onChange={(event) => patch({ location: event.target.value })}
                />
              </Field>
            </div>

            <div className="stack">
              <Switch
                checked={state.allDay}
                onChange={(checked) =>
                  patch({
                    allDay: checked,
                    endDate: checked && state.endDate < state.startDate ? state.startDate : state.endDate,
                  })
                }
                label="全天日程"
                description="全天日程不占用具体时段，适合出差、纪念日这类安排。"
              />

              <div className="form-grid">
                <Field label="开始日期" required>
                  <Input
                    type="date"
                    value={state.startDate}
                    onChange={(event) => {
                      const value = event.target.value;
                      patch({
                        startDate: value,
                        endDate: state.endDate < value ? value : state.endDate,
                        until: state.until < value ? value : state.until,
                      });
                    }}
                  />
                </Field>

                {!state.allDay && (
                  <Field label="开始时间" required>
                    <Input
                      type="time"
                      step={300}
                      value={state.startTime}
                      onChange={(event) => patch({ startTime: event.target.value })}
                    />
                  </Field>
                )}

                <Field label="结束日期" required>
                  <Input
                    type="date"
                    min={state.startDate}
                    value={state.endDate}
                    onChange={(event) => patch({ endDate: event.target.value })}
                  />
                </Field>

                {!state.allDay && (
                  <Field label="结束时间" required>
                    <Input
                      type="time"
                      step={300}
                      value={state.endTime}
                      onChange={(event) => patch({ endTime: event.target.value })}
                    />
                  </Field>
                )}
              </div>

              {!state.allDay && (
                <div className="row row--wrap">
                  <span className="faint" style={{ fontSize: 'var(--text-xs)' }}>
                    快捷时长
                  </span>
                  {DURATION_OPTIONS.map((option) => (
                    <Chip
                      key={option.value}
                      onClick={() =>
                        patch({ endTime: addMinutesToTime(state.startTime, option.value), endDate: state.startDate })
                      }
                    >
                      {option.label}
                    </Chip>
                  ))}
                  {durationLabel && <Badge tone="accent">当前 {durationLabel}</Badge>}
                </div>
              )}
            </div>

            <div className="card" style={{ padding: 'var(--space-4)' }}>
              <Switch
                checked={state.recurrenceEnabled}
                onChange={(checked) =>
                  patch({
                    recurrenceEnabled: checked,
                    byWeekday:
                      state.byWeekday.length > 0 ? state.byWeekday : [new Date(`${state.startDate}T00:00`).getDay()],
                  })
                }
                label="重复日程"
                description="支持每天、每周、每月、每年重复，并可指定结束条件。"
              />

              {state.recurrenceEnabled && (
                <div className="stack">
                  <div className="form-grid">
                    <Field label="重复频率">
                      <Select
                        value={state.freq}
                        onChange={(event) =>
                          patch({ freq: event.target.value as EventFormState['freq'] })
                        }
                      >
                        {FREQUENCY_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <Field
                      label="间隔"
                      hint={
                        state.interval > 1
                          ? `每 ${state.interval} ${state.freq === 'DAILY' ? '天' : state.freq === 'WEEKLY' ? '周' : state.freq === 'MONTHLY' ? '月' : '年'}一次`
                          : '每 1 个单位重复一次'
                      }
                    >
                      <Input
                        type="number"
                        min={1}
                        max={365}
                        value={state.interval}
                        onChange={(event) => patch({ interval: Number(event.target.value) })}
                      />
                    </Field>
                  </div>

                  {state.freq === 'WEEKLY' && (
                    <Field label="重复星期" hint="可多选，例如每周一、三、五。">
                      <div className="weekday-picker">
                        {WEEKDAY_OPTIONS.map((option) => {
                          const selected = state.byWeekday.includes(option.value);
                          return (
                            <button
                              key={option.value}
                              type="button"
                              className={cn('weekday-picker__day', selected && 'is-selected')}
                              aria-pressed={selected}
                              onClick={() =>
                                patch({
                                  byWeekday: selected
                                    ? state.byWeekday.filter((value) => value !== option.value)
                                    : [...state.byWeekday, option.value],
                                })
                              }
                            >
                              {option.short}
                            </button>
                          );
                        })}
                      </div>
                    </Field>
                  )}

                  <Field label="结束条件">
                    <SegmentedControl
                      value={state.recurrenceEnd}
                      onChange={(value) => patch({ recurrenceEnd: value })}
                      ariaLabel="重复结束条件"
                      options={[
                        { value: 'never', label: '一直重复' },
                        { value: 'count', label: '按次数' },
                        { value: 'until', label: '按日期' },
                      ]}
                    />
                  </Field>

                  {state.recurrenceEnd === 'count' && (
                    <Field label="重复次数" hint="从第一次开始计算，最多 500 次。">
                      <Input
                        type="number"
                        min={1}
                        max={500}
                        value={state.count}
                        onChange={(event) => patch({ count: Number(event.target.value) })}
                      />
                    </Field>
                  )}

                  {state.recurrenceEnd === 'until' && (
                    <Field label="重复截止日期" hint="包含该日期当天。">
                      <Input
                        type="date"
                        min={state.startDate}
                        value={state.until}
                        onChange={(event) => patch({ until: event.target.value })}
                      />
                    </Field>
                  )}
                </div>
              )}
            </div>

            <div className="form-grid">
              <Field label="提醒">
                <Select
                  value={state.remindMinutesBefore === null ? 'none' : String(state.remindMinutesBefore)}
                  onChange={(event) =>
                    patch({
                      remindMinutesBefore: event.target.value === 'none' ? null : Number(event.target.value),
                    })
                  }
                >
                  <option value="none">不提醒</option>
                  {REMINDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="状态">
                <Select
                  value={state.status}
                  onChange={(event) => patch({ status: event.target.value as EventFormState['status'] })}
                >
                  <option value="confirmed">已确认</option>
                  <option value="tentative">待定</option>
                  <option value="cancelled">已取消</option>
                </Select>
              </Field>
            </div>

            <Field label="颜色" hint="留空则跟随分类颜色。">
              <div className="color-picker">
                <button
                  type="button"
                  className={cn('color-picker__swatch', state.color === null && 'is-selected')}
                  style={
                    {
                      background: 'var(--bg-inset)',
                      '--color-value': 'var(--text-faint)',
                    } as CSSProperties
                  }
                  aria-label="跟随分类颜色"
                  title="跟随分类颜色"
                  onClick={() => patch({ color: null })}
                />
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={cn('color-picker__swatch', state.color === color && 'is-selected')}
                    style={{ background: color, '--color-value': color } as CSSProperties}
                    aria-label={`选择颜色 ${color}`}
                    title={color}
                    onClick={() => patch({ color })}
                  />
                ))}
                <input
                  type="color"
                  className="input"
                  style={{ width: 44, height: 28, padding: 2 }}
                  value={state.color ?? '#0f766e'}
                  aria-label="自定义颜色"
                  onChange={(event) => patch({ color: event.target.value })}
                />
              </div>
            </Field>

            <Field label="标签" hint="回车添加，最多 20 个。">
              <div className="tag-input">
                <Input
                  value={tagDraft}
                  placeholder="例如：客户、季度目标"
                  maxLength={30}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                />
                <Button onClick={addTag} disabled={tagDraft.trim().length === 0}>
                  添加
                </Button>
              </div>
              {state.tags.length > 0 && (
                <div className="tag-list">
                  {state.tags.map((tag) => (
                    <Chip key={tag} onRemove={() => patch({ tags: state.tags.filter((item) => item !== tag) })}>
                      {tag}
                    </Chip>
                  ))}
                </div>
              )}
            </Field>

            <Field label="备注">
              <Textarea
                value={state.description}
                maxLength={4000}
                placeholder="补充说明、参会人、准备事项……"
                onChange={(event) => patch({ description: event.target.value })}
              />
            </Field>
          </div>
        )}
      </Modal>

      {editor.mode === 'edit' && (
        <EventDeleteDialog
          open={deleteOpen}
          occurrence={editor.occurrence}
          busy={busy}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={({ scope: deleteScope, occurrenceKey }) => {
            setDeleteOpen(false);
            const finish = { onSuccess: () => closeEditor() };
            if (deleteScope === 'series') {
              deleteEvent.mutate(editor.occurrence.eventId, finish);
            } else {
              cancelOccurrence.mutate(
                {
                  eventId: editor.occurrence.eventId,
                  occurrenceKey,
                  scope: deleteScope === 'future' ? 'future' : 'single',
                },
                finish,
              );
            }
          }}
        />
      )}
    </>
  );
}
