/** 待办清单：快速录入、按状态筛选、与设备端「待办」窗格同源。 */

import { useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { useTodos } from '@/api/use-workspace';
import {
  useCreateTodo,
  useDeleteTodo,
  useToggleTodo,
  useUpdateTodo,
} from '@/api/use-workspace-mutations';
import { AppShell } from '@/components/layout/AppShell';
import { useShellTopBar } from '@/hooks/use-shell';
import { cn } from '@/lib/cn';
import { describeDue, PRIORITY_LABEL, PRIORITY_ORDER, PRIORITY_TONE } from '@/lib/labels';
import { Badge, Button, ErrorState, SegmentedControl, Skeleton } from '@/components/ui';
import { Icon } from '@/components/ui/icon';
import type { Priority, Todo } from '@/types';

type TodoFilter = 'active' | 'today' | 'done' | 'all';

const FILTER_OPTIONS: { value: TodoFilter; label: string }[] = [
  { value: 'active', label: '进行中' },
  { value: 'today', label: '今天到期' },
  { value: 'done', label: '已完成' },
  { value: 'all', label: '全部' },
];

function TodoItem({
  todo,
  onToggle,
  onDelete,
  onPriority,
}: {
  todo: Todo;
  onToggle: () => void;
  onDelete: () => void;
  onPriority: () => void;
}): ReactElement {
  const due = describeDue(todo.dueDate);
  return (
    <div className={cn('todo-row', todo.done && 'is-done')}>
      <button
        type="button"
        className={cn('todo-row__check', todo.done && 'is-done')}
        aria-label={todo.done ? `取消完成 ${todo.title}` : `完成 ${todo.title}`}
        aria-pressed={todo.done}
        onClick={onToggle}
      >
        <Icon name="check" size={14} weight="bold" />
      </button>

      <div className="todo-row__body">
        <span className="todo-row__title">{todo.title}</span>
        <span className="todo-row__meta">
          {todo.notes && <span className="truncate">{todo.notes}</span>}
          {todo.priority !== 'normal' && (
            <Badge tone={PRIORITY_TONE[todo.priority]}>{PRIORITY_LABEL[todo.priority]}</Badge>
          )}
          {todo.dueDate && (
            <span
              className={cn(
                'todo-row__due',
                due.state === 'overdue' && !todo.done && 'is-overdue',
                due.state === 'today' && !todo.done && 'is-today',
              )}
            >
              <Icon name="calendar-check" size={12} />
              {due.label}
            </span>
          )}
          {todo.done && todo.completedAt && (
            <span>完成于 {format(new Date(todo.completedAt), 'M 月 d 日')}</span>
          )}
        </span>
      </div>

      <div className="todo-row__actions">
        <Button size="sm" variant="ghost" onClick={onPriority} title="切换优先级">
          {PRIORITY_LABEL[todo.priority]}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leadingIcon="trash"
          aria-label={`删除 ${todo.title}`}
          onClick={onDelete}
        />
      </div>
    </div>
  );
}

export function TodosPage(): ReactElement {
  const topbar = useShellTopBar({ showFilters: false });
  const inputRef = useRef<HTMLInputElement>(null);

  const [filter, setFilter] = useState<TodoFilter>('active');
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [dueToday, setDueToday] = useState(false);

  const todosQuery = useTodos({ limit: 500 });
  const createTodo = useCreateTodo();
  const toggleTodo = useToggleTodo();
  const deleteTodo = useDeleteTodo();
  const updateTodo = useUpdateTodo();

  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const all = useMemo(() => todosQuery.data?.items ?? [], [todosQuery.data]);

  const stats = useMemo(() => {
    let active = 0;
    let done = 0;
    let dueTodayCount = 0;
    let overdue = 0;
    for (const todo of all) {
      if (todo.done) {
        done += 1;
        continue;
      }
      active += 1;
      if (todo.dueDate === todayKey) dueTodayCount += 1;
      if (todo.dueDate && todo.dueDate < todayKey) overdue += 1;
    }
    return { active, done, dueToday: dueTodayCount, overdue };
  }, [all, todayKey]);

  const visible = useMemo(() => {
    if (filter === 'active') return all.filter((todo) => !todo.done);
    if (filter === 'done') return all.filter((todo) => todo.done);
    if (filter === 'today') return all.filter((todo) => !todo.done && todo.dueDate === todayKey);
    return all;
  }, [all, filter, todayKey]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const value = title.trim();
    if (value.length === 0) {
      inputRef.current?.focus();
      return;
    }
    createTodo.mutate(
      {
        title: value,
        priority,
        dueDate: dueToday ? todayKey : null,
      },
      {
        onSuccess: () => {
          setTitle('');
          setPriority('normal');
          setDueToday(false);
          inputRef.current?.focus();
        },
      },
    );
  };

  const cyclePriority = (todo: Todo): void => {
    const index = PRIORITY_ORDER.indexOf(todo.priority);
    const next = PRIORITY_ORDER[(index + 1) % PRIORITY_ORDER.length] ?? 'normal';
    updateTodo.mutate({ id: todo.id, payload: { priority: next } });
  };

  const body = (): ReactElement => {
    if (todosQuery.isError) {
      return (
        <ErrorState
          title="待办加载失败"
          description="请确认后端服务已启动（默认 http://127.0.0.1:4000）。"
          detail={todosQuery.error instanceof Error ? todosQuery.error.message : undefined}
          onRetry={() => void todosQuery.refetch()}
        />
      );
    }

    if (todosQuery.isLoading) {
      return (
        <div className="stack">
          <Skeleton height={34} />
          <Skeleton height={64} />
          <Skeleton height={64} />
          <Skeleton height={64} />
        </div>
      );
    }

    if (visible.length === 0) {
      const hint =
        filter === 'done'
          ? '还没有已完成的待办。'
          : filter === 'today'
            ? '今天没有到期的待办。'
            : '清单是空的。写下第一件要做的事，它也会出现在桌面屏幕的「待办」窗格里。';
      return <div className="empty-hint">{hint}</div>;
    }

    return (
      <div className="todo-list">
        {visible.map((todo) => (
          <TodoItem
            key={todo.id}
            todo={todo}
            onToggle={() => toggleTodo.mutate({ id: todo.id, done: !todo.done })}
            onDelete={() => deleteTodo.mutate(todo.id)}
            onPriority={() => cyclePriority(todo)}
          />
        ))}
      </div>
    );
  };

  return (
    <AppShell topbar={topbar}>
      <div className="page">
        <header className="page__header">
          <div className="page__heading">
            <p className="page__eyebrow">Todo · 未竟事项</p>
            <h1 className="page__title">待办清单</h1>
            <p className="page__subtitle">
              待办只保留「还没做完」的事，完成即勾去。设备端只显示未完成的前 8 条，
              不堆积、不提醒轰炸。
            </p>
          </div>
        </header>

        <div className="todos-layout">
          <div className="stack stack--lg">
            <section className="card" aria-label="新建待办">
              <form className="quick-add" onSubmit={submit}>
                <input
                  ref={inputRef}
                  className="input"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="记下一件要做的事，回车添加"
                  maxLength={200}
                  aria-label="待办内容"
                />
                <label className="field" style={{ gap: 0 }}>
                  <span className="sr-only">优先级</span>
                  <select
                    className="input"
                    style={{ width: 110, height: 48 }}
                    value={priority}
                    onChange={(event) => setPriority(event.target.value as Priority)}
                    aria-label="优先级"
                  >
                    {PRIORITY_ORDER.map((value) => (
                      <option value={value} key={value}>
                        {PRIORITY_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={cn('quick-add__due', dueToday && 'is-on')}
                  aria-pressed={dueToday}
                  onClick={() => setDueToday((value) => !value)}
                >
                  <Icon name="calendar-check" size={15} />
                  今天到期
                </button>
                <Button type="submit" variant="primary" leadingIcon="plus" loading={createTodo.isPending}>
                  添加
                </Button>
              </form>
            </section>

            <section className="card" aria-label="待办列表">
              <div className="section-head">
                <span className="section-head__title">
                  清单
                  <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                    {visible.length} 项
                  </span>
                </span>
                <SegmentedControl<TodoFilter>
                  value={filter}
                  onChange={setFilter}
                  ariaLabel="筛选待办"
                  size="sm"
                  options={FILTER_OPTIONS}
                />
              </div>
              {body()}
            </section>
          </div>

          <aside className="stack stack--lg" aria-label="待办概览">
            <section className="card">
              <span className="section-head__title">概览</span>
              <div className="metric-grid">
                <div className="metric-tile">
                  <span className="metric-tile__label">进行中</span>
                  <span className="metric-tile__value">{stats.active}</span>
                </div>
                <div className="metric-tile">
                  <span className="metric-tile__label">今天到期</span>
                  <span className="metric-tile__value">{stats.dueToday}</span>
                </div>
                <div className="metric-tile">
                  <span className="metric-tile__label">已逾期</span>
                  <span className="metric-tile__value" style={{ color: stats.overdue ? 'var(--danger)' : undefined }}>
                    {stats.overdue}
                  </span>
                </div>
                <div className="metric-tile">
                  <span className="metric-tile__label">已完成</span>
                  <span className="metric-tile__value">{stats.done}</span>
                </div>
              </div>
            </section>

            <section className="card card--quiet">
              <span className="section-head__title">它们会显示在哪</span>
              <p className="page-hint">
                设备的「待办」窗格按优先级与截止日期取前 8 条未完成事项。
                你在这里勾掉一条，下次屏幕刷新时它就会消失。
              </p>
              <div className="row row--wrap">
                <Link className="btn btn--secondary btn--md" to="/device">
                  <Icon name="monitor" size={16} />
                  <span className="btn__label">查看屏幕布局</span>
                </Link>
                <Link className="btn btn--ghost btn--md" to="/weather">
                  <Icon name="cloud-sun" size={16} />
                  <span className="btn__label">天气窗格</span>
                </Link>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
