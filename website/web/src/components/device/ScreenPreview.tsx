/**
 * 800 × 480 电子墨水屏预览。
 *
 * 按服务端下发的模块矩形做绝对定位，再整体等比缩放到容器宽度；
 * 这里刻意只使用黑 / 白 / 灰度，与设备端 1-bit 渲染的观感保持一致。
 */

import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/ui/icon';
import { formatTime } from '@/lib/date';
import { weatherIconName } from '@/lib/labels';
import type {
  DeviceEvent,
  DeviceScreenPayload,
  DeviceTodo,
  DisplayLayout,
  DisplayModule,
  DisplayModuleId,
  WeatherSnapshot,
} from '@/types';

const CANVAS_WIDTH = 800;
const CALENDAR_WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const;

export const MODULE_LABEL: Record<DisplayModuleId, string> = {
  clock: '时钟',
  calendar: '月历',
  weather: '天气',
  schedule: '今日日程',
  courses: '今日课程',
  todos: '待办',
};

/** 监听容器宽度，换算成画布缩放比例。 */
function useCanvasScale(ref: RefObject<HTMLDivElement>): number {
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setScale(entry.contentRect.width / CANVAS_WIDTH);
    });
    observer.observe(element);
    setScale(element.clientWidth / CANVAS_WIDTH);
    return () => observer.disconnect();
  }, [ref]);

  return scale;
}

function timeLabel(event: Pick<DeviceEvent, 'allDay' | 'startAt'>): string {
  if (event.allDay) return '全天';
  return formatTime(new Date(event.startAt));
}

function fitRows(height: number, reserved: number, rowHeight: number): number {
  return Math.max(1, Math.floor((height - reserved) / rowHeight));
}

/* ------------------------------ 单个模块 ------------------------------ */

function ClockModule({ payload }: { payload: DeviceScreenPayload }): ReactElement {
  return (
    <div>
      <div className="eink-clock__date">
        {payload.now.dateLabel} · {payload.now.weekday}
      </div>
      <div className="eink-clock__time">{payload.now.time}</div>
    </div>
  );
}

function CalendarModule({ payload }: { payload: DeviceScreenPayload }): ReactElement {
  const { year, month, firstWeekday, daysInMonth, today, marks } = payload.month;
  const offset = (firstWeekday + 6) % 7;
  const marked = new Set(marks);
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - offset + 1;
    return { index, day, visible: day >= 1 && day <= daysInMonth };
  });

  return (
    <div className="eink-calendar">
      <div className="eink-calendar__head">
        <span className="eink-calendar__month">
          {year} 年 {month} 月
        </span>
        <span>MON — SUN</span>
      </div>
      <div className="eink-calendar__grid">
        {CALENDAR_WEEKDAYS.map((weekday) => (
          <span className="eink-calendar__weekday" key={weekday}>
            {weekday}
          </span>
        ))}
        {cells.map((cell) =>
          cell.visible ? (
            <span
              key={cell.index}
              className={cn(
                'eink-calendar__day',
                cell.day === today && 'is-today',
                marked.has(cell.day) && 'is-marked',
              )}
            >
              {cell.day}
            </span>
          ) : (
            <span key={cell.index} className="eink-calendar__day is-outside" />
          ),
        )}
      </div>
    </div>
  );
}

function WeatherModule({
  weather,
  height,
}: {
  weather: WeatherSnapshot | null;
  height: number;
}): ReactElement {
  if (!weather) {
    return <span className="eink-empty">暂无天气数据</span>;
  }

  const { current, today, forecast } = weather;
  const showForecast = height >= 200 && forecast.length > 0;

  return (
    <div className="eink-weather">
      <div className="eink-weather__main">
        <Icon name={weatherIconName(current.icon)} size={40} weight="light" />
        <div>
          <div className="eink-weather__temp">{Math.round(current.temperature)}°</div>
          <div className="eink-weather__condition">
            {current.condition} · {Math.round(today.max)}° / {Math.round(today.min)}°
          </div>
        </div>
      </div>
      <div className="eink-weather__meta">
        <span>体感 {Math.round(current.apparentTemperature)}°</span>
        <span>湿度 {current.humidity}%</span>
        <span>风 {Math.round(current.windSpeed)} km/h</span>
      </div>
      {showForecast && (
        <div className="eink-forecast">
          {forecast.map((day) => (
            <span className="eink-forecast__day" key={day.date}>
              <Icon name={weatherIconName(day.icon)} size={15} weight="light" />
              <span>{day.weekday.replace('周', '')}</span>
              <span className="eink-forecast__range">
                {Math.round(day.max)}° / {Math.round(day.min)}°
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleModule({
  events,
  height,
}: {
  events: DeviceEvent[];
  height: number;
}): ReactElement {
  if (events.length === 0) {
    return (
      <div>
        <div className="eink-title">今日日程</div>
        <span className="eink-empty">今天没有安排</span>
      </div>
    );
  }

  const rows = fitRows(height, 34, 22);
  return (
    <div>
      <div className="eink-title">今日日程</div>
      <div className="eink-list">
        {events.slice(0, rows).map((event) => (
          <div className="eink-row" key={event.id}>
            <span className="eink-row__time">{timeLabel(event)}</span>
            <span className="eink-row__title">{event.title}</span>
            {event.location && <span className="eink-row__meta">{event.location}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function CoursesModule({
  courses,
  height,
}: {
  courses: DeviceEvent[];
  height: number;
}): ReactElement {
  if (courses.length === 0) {
    return (
      <div>
        <div className="eink-title">今日课程</div>
        <span className="eink-empty">今天没有课</span>
      </div>
    );
  }

  const rows = fitRows(height, 34, 22);
  return (
    <div>
      <div className="eink-title">今日课程</div>
      <div className="eink-list">
        {courses.slice(0, rows).map((course) => (
          <div className="eink-row" key={course.id}>
            <span className="eink-row__time">{timeLabel(course)}</span>
            <span className="eink-row__title">{course.title}</span>
            {course.location && <span className="eink-row__meta">{course.location}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function TodosModule({ todos, height }: { todos: DeviceTodo[]; height: number }): ReactElement {
  if (todos.length === 0) {
    return (
      <div>
        <div className="eink-title">待办</div>
        <span className="eink-empty">没有未完成事项</span>
      </div>
    );
  }

  const rows = fitRows(height, 34, 22);
  return (
    <div>
      <div className="eink-title">待办</div>
      <div className="eink-list">
        {todos.slice(0, rows).map((todo) => (
          <div className="eink-todo" key={todo.id}>
            <span className="eink-todo__box" />
            <span className="eink-todo__title">{todo.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------ 模块容器 ------------------------------ */

function ModuleBody({
  module,
  payload,
}: {
  module: DisplayModule;
  payload: DeviceScreenPayload;
}): ReactElement {
  switch (module.id) {
    case 'clock':
      return <ClockModule payload={payload} />;
    case 'calendar':
      return <CalendarModule payload={payload} />;
    case 'weather':
      return <WeatherModule weather={payload.weather} height={module.h} />;
    case 'schedule':
      return <ScheduleModule events={payload.events} height={module.h} />;
    case 'courses':
      return <CoursesModule courses={payload.courses} height={module.h} />;
    case 'todos':
      return <TodosModule todos={payload.todos} height={module.h} />;
    default:
      return <span className="eink-empty">未知模块</span>;
  }
}

/* ------------------------------ 预览组件 ------------------------------ */

export interface ScreenPreviewProps {
  payload: DeviceScreenPayload | undefined;
  /** 布局编辑器里的本地草稿，优先于服务端布局 */
  layout?: DisplayLayout;
  /** 在模块右上角显示模块名（编辑时帮助定位） */
  labels?: boolean;
  className?: string;
}

export function ScreenPreview({
  payload,
  layout,
  labels = false,
  className,
}: ScreenPreviewProps): ReactElement {
  const frameRef = useRef<HTMLDivElement>(null);
  const scale = useCanvasScale(frameRef);
  const modules = layout?.modules ?? payload?.screen.layout.modules ?? [];
  const visible = [...modules]
    .filter((module) => module.enabled)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  return (
    <div ref={frameRef} className={cn('screen-frame', className)}>
      {payload && scale > 0 ? (
        <div
          className={cn('screen-canvas', labels && 'is-editing')}
          style={{ transform: `scale(${scale})` }}
        >
          {visible.map((module) => (
            <section
              key={module.id}
              className="eink-module"
              style={{
                left: module.x,
                top: module.y,
                width: module.w,
                height: module.h,
              }}
              aria-label={MODULE_LABEL[module.id]}
            >
              {labels && <span className="eink-module__label">{MODULE_LABEL[module.id]}</span>}
              <ModuleBody module={module} payload={payload} />
            </section>
          ))}
        </div>
      ) : (
        <span className="eink-empty screen-frame__empty">
          {payload ? '正在生成预览…' : '暂无预览数据'}
        </span>
      )}
    </div>
  );
}
