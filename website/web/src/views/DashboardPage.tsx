/** 总览：把「设备上会看到的那一屏」放大成管理工作台的主界面。 */

import { useMemo, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { format, getISOWeek } from 'date-fns';
import { useCategories } from '@/api/use-calendar-data';
import { useDevices } from '@/api/use-devices';
import { useScreenPreview } from '@/api/use-workspace';
import { useToggleTodo } from '@/api/use-workspace-mutations';
import { ScreenPreview } from '@/components/device/ScreenPreview';
import { AppShell } from '@/components/layout/AppShell';
import { useShellTopBar } from '@/hooks/use-shell';
import { useNow } from '@/hooks/use-now';
import { cn } from '@/lib/cn';
import { WEEKDAY_LONG, formatTime } from '@/lib/date';
import { describeUpdatedAt, weatherIconName } from '@/lib/labels';
import { toast, useUiStore } from '@/store/ui-store';
import { Badge, Button, ErrorState, Skeleton } from '@/components/ui';
import { Icon } from '@/components/ui/icon';

function greetingOf(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function DashboardPage(): ReactElement {
  const topbar = useShellTopBar({ showFilters: false });
  const navigate = useNavigate();
  const now = useNow(20_000);
  const screen = useScreenPreview();
  const devices = useDevices();
  const primaryDevice = devices.data?.[0];
  const categories = useCategories();
  const toggleTodo = useToggleTodo();

  const openCreateEditor = useUiStore((state) => state.openCreateEditor);

  const categoriesById = useMemo(
    () => new Map((categories.data ?? []).map((category) => [category.id, category])),
    [categories.data],
  );

  const payload = screen.data;
  const events = useMemo(() => payload?.events ?? [], [payload]);
  const courses = useMemo(() => payload?.courses ?? [], [payload]);
  const todos = useMemo(() => payload?.todos ?? [], [payload]);
  const weather = payload?.weather;

  const usageMinutes = useMemo(
    () =>
      events.reduce((total, event) => {
        if (event.allDay) return total;
        return total + Math.max(0, (new Date(event.endAt).getTime() - new Date(event.startAt).getTime()) / 60_000);
      }, 0),
    [events],
  );

  const nextEvent = useMemo(
    () => events.find((event) => new Date(event.endAt).getTime() > now.getTime()),
    [events, now],
  );

  const weekday = WEEKDAY_LONG[(now.getDay() + 6) % 7] ?? '周一';
  const dateLabel = format(now, 'yyyy 年 M 月 d 日');
  const weekNumber = getISOWeek(now);

  const quickCreate = (): void => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    openCreateEditor({
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 3_600_000).toISOString(),
      allDay: false,
    });
  };

  const completeTodo = (id: number, title: string): void => {
    toggleTodo.mutate(
      { id, done: true },
      { onSuccess: () => toast.success('已完成', title) },
    );
  };

  if (screen.isError) {
    return (
      <AppShell topbar={topbar}>
        <div className="page page--wide">
          <ErrorState
            title="总览数据加载失败"
            description="总览使用设备端的屏幕数据接口（/api/display/screen）。请确认后端已启动。"
            detail={screen.error instanceof Error ? screen.error.message : undefined}
            onRetry={() => void screen.refetch()}
          />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell topbar={topbar}>
      <div className="page page--wide">
        <header className="page__header">
          <div className="page__heading">
            <p className="page__eyebrow">
              {dateLabel} · {weekday} · 第 {weekNumber} 周
            </p>
            <h1 className="page__title">
              {greetingOf(now.getHours())}，今天有 {events.length + courses.length} 件事
            </h1>
            <p className="page__subtitle">
              这些内容会按你在「设备」页设定的窗格排布，安静地铺在桌面墨水屏上。
            </p>
          </div>
          <div className="page__actions">
            <Button variant="secondary" leadingIcon="monitor" onClick={() => navigate('/device')}>
              屏幕预览
            </Button>
            <Button variant="primary" leadingIcon="plus" onClick={quickCreate}>
              新建日程
            </Button>
          </div>
        </header>

        <div className="dashboard-grid">
          {/* 今天 · 大时钟 */}
          <section className="hero-card span-5" aria-label="今天">
            <div>
              <span className="hero-card__eyebrow">Today</span>
              <div className="hero-card__time">{format(now, 'HH:mm')}</div>
              <div className="hero-card__date">
                {weekday} · {format(now, 'M 月 d 日')}
              </div>
            </div>

            <div className="hero-card__stats">
              <div className="hero-card__stat">
                <span className="hero-card__stat-value numeric">{events.length}</span>
                <span className="hero-card__stat-label">今日日程</span>
              </div>
              <div className="hero-card__stat">
                <span className="hero-card__stat-value numeric">{courses.length}</span>
                <span className="hero-card__stat-label">今日课程</span>
              </div>
              <div className="hero-card__stat">
                <span className="hero-card__stat-value numeric">
                  {Math.round(usageMinutes / 60)}
                  <small style={{ fontSize: 'var(--text-sm)' }}> h</small>
                </span>
                <span className="hero-card__stat-label">已排时长</span>
              </div>
              <div className="hero-card__stat">
                <span className="hero-card__stat-value numeric">{todos.length}</span>
                <span className="hero-card__stat-label">待办未完成</span>
              </div>
            </div>

            {nextEvent ? (
              <div className="hero-card__next">
                <span className="hero-card__next-label">接下来</span>
                <span className="hero-card__next-time">
                  {nextEvent.allDay ? '全天' : formatTime(new Date(nextEvent.startAt))}
                </span>
                <span className="hero-card__next-title">{nextEvent.title}</span>
              </div>
            ) : (
              <div className="hero-card__next">
                <span className="hero-card__next-label">接下来</span>
                <span className="hero-card__next-title">今天的安排都结束了，早点休息。</span>
              </div>
            )}
          </section>

          {/* 天气 */}
          <section className="weather-card span-4" aria-label="天气">
            <div className="weather-card__head">
              <span className="weather-card__city">
                <Icon name="map-pin" size={15} />
                {weather?.city ?? '上海'}
              </span>
              <Badge tone={weather?.stale ? 'warning' : 'neutral'}>
                {weather?.stale ? '缓存' : describeUpdatedAt(weather?.fetchedAt ?? undefined)}
              </Badge>
            </div>

            {weather ? (
              <>
                <div className="weather-card__main">
                  <Icon
                    name={weatherIconName(weather.current.icon)}
                    size={44}
                    weight="light"
                    className="weather-card__icon"
                  />
                  <div>
                    <div className="weather-card__temp">
                      {Math.round(weather.current.temperature)}
                      <sup>°</sup>
                    </div>
                    <div className="weather-card__condition">
                      {weather.current.condition} · 体感 {Math.round(weather.current.apparentTemperature)}°
                    </div>
                  </div>
                </div>

                <div className="weather-card__meta">
                  <span>
                    <Icon name="thermometer" size={14} /> {Math.round(weather.today.min)}° / {Math.round(weather.today.max)}°
                  </span>
                  <span>
                    <Icon name="drop" size={14} /> 湿度 {weather.current.humidity}%
                  </span>
                  <span>
                    <Icon name="wind" size={14} /> {Math.round(weather.current.windSpeed)} km/h
                  </span>
                </div>

                <div className="weather-mini">
                  {weather.forecast.slice(0, 3).map((day) => (
                    <span className="weather-mini__day" key={day.date}>
                      <Icon name={weatherIconName(day.icon)} size={16} weight="light" />
                      <span>{day.weekday.replace('周', '')}</span>
                      <span className="weather-mini__range">
                        {Math.round(day.max)}° / {Math.round(day.min)}°
                      </span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-hint">还没有天气数据。天气服务会按设定的位置定时拉取。</div>
            )}
          </section>

          {/* 桌面屏幕 */}
          <section className="device-card span-3" aria-label="桌面屏幕">
            <div className="section-head">
              <span className="section-head__title">桌面屏幕</span>
              <Link className="section-head__link" to="/device">
                设置 <Icon name="arrow-right" size={13} />
              </Link>
            </div>

            <div className="device-card__frame">
              <ScreenPreview payload={payload} />
            </div>

            <div className="device-card__meta">
              <div className="device-card__meta-row">
                <span>状态</span>
                <strong>{primaryDevice?.online ? '已配对' : '等待配对'}</strong>
              </div>
              <div className="device-card__meta-row">
                <span>电量</span>
                <strong>{primaryDevice?.batteryPercent != null ? `${primaryDevice.batteryPercent}%` : '—'}</strong>
              </div>
              <div className="device-card__meta-row">
                <span>刷新间隔</span>
                <strong>{payload?.screen.refreshMinutes ?? 30} 分钟</strong>
              </div>
            </div>
          </section>

          {/* 今日日程 */}
          <section className="card span-7" aria-label="今日日程">
            <div className="section-head">
              <span className="section-head__title">今日日程</span>
              <Link className="section-head__link" to={`/calendar/day?d=${format(now, 'yyyy-MM-dd')}`}>
                在日历中打开 <Icon name="arrow-right" size={13} />
              </Link>
            </div>

            {screen.isLoading ? (
              <div className="stack">
                <Skeleton height={54} />
                <Skeleton height={54} />
                <Skeleton height={54} />
              </div>
            ) : events.length === 0 ? (
              <div className="empty-hint">今天没有日程。新建一条，它会出现在屏幕的「今日日程」窗格里。</div>
            ) : (
              <div className="today-list">
                {events.slice(0, 6).map((event) => {
                  const color =
                    categoriesById.get(event.categoryId ?? -1)?.color ?? event.color ?? 'var(--accent)';
                  return (
                    <button
                      type="button"
                      className="today-list__row"
                      key={event.id}
                      onClick={() => navigate(`/calendar/day?d=${format(now, 'yyyy-MM-dd')}`)}
                    >
                      <span className="today-list__time">
                        {event.allDay ? '全天' : formatTime(new Date(event.startAt))}
                      </span>
                      <span className="today-list__dot" style={{ background: color }} />
                      <span className="today-list__body">
                        <span className="today-list__title">{event.title}</span>
                        <span className="today-list__meta">
                          {event.location || '未填写地点'}
                          {event.allDay ? ' · 全天' : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* 右列：课程 + 待办 */}
          <div className="span-5 dashboard-stack">
            <section className="card" aria-label="今日课程">
              <div className="section-head">
                <span className="section-head__title">今日课程</span>
                <Link className="section-head__link" to="/courses">
                  课表 <Icon name="arrow-right" size={13} />
                </Link>
              </div>
              {courses.length === 0 ? (
                <div className="empty-hint">今天没有课。已同步的课表会自动出现在这里。</div>
              ) : (
                <div className="today-list">
                  {courses.slice(0, 4).map((course) => (
                    <div className="today-list__row" key={course.id}>
                      <span className="today-list__time">{formatTime(new Date(course.startAt))}</span>
                      <span className="today-list__body">
                        <span className="today-list__title">{course.title}</span>
                        <span className="today-list__meta">{course.location || '未填写教室'}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="card" aria-label="待办">
              <div className="section-head">
                <span className="section-head__title">待办</span>
                <Link className="section-head__link" to="/todos">
                  全部 <Icon name="arrow-right" size={13} />
                </Link>
              </div>
              {todos.length === 0 ? (
                <div className="empty-hint">没有未完成事项。</div>
              ) : (
                <div className="today-list">
                  {todos.slice(0, 5).map((todo) => (
                    <div className="today-list__row" key={todo.id}>
                      <button
                        type="button"
                        className="todo-row__check"
                        aria-label={`完成 ${todo.title}`}
                        onClick={() => completeTodo(todo.id, todo.title)}
                        style={{ marginTop: 1 }}
                      >
                        <Icon name="check" size={13} weight="bold" />
                      </button>
                      <span className="today-list__body">
                        <span className="today-list__title">{todo.title}</span>
                        <span className={cn('today-list__meta')}>
                          {todo.dueDate ? `${todo.dueDate.slice(5)} 到期` : '无截止日期'}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
