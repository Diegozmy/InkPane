/** 事件表单的状态模型与转换逻辑（与视图解耦，便于单测）。 */

import type {
  CalendarEvent,
  EventPayload,
  EventStatus,
  Occurrence,
  Priority,
  RecurrenceFrequency,
  RecurrenceRule,
} from '@/types';
import type { EditorDefaults } from '@/store/ui-store';

export interface EventFormState {
  title: string;
  description: string;
  location: string;
  categoryId: number | null;
  color: string | null;
  priority: Priority;
  status: EventStatus;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  tags: string[];
  recurrenceEnabled: boolean;
  freq: RecurrenceFrequency;
  interval: number;
  byWeekday: number[];
  recurrenceEnd: 'never' | 'count' | 'until';
  count: number;
  until: string;
  remindMinutesBefore: number | null;
}

export type EditScope = 'single' | 'all';

function pad(value: number): string {
  return `${value}`.padStart(2, '0');
}

export function dateKeyOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function timeKeyOf(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function splitInstant(iso: string): { date: string; time: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return { date: dateKeyOf(now), time: timeKeyOf(now) };
  }
  return { date: dateKeyOf(date), time: timeKeyOf(date) };
}

/** 'YYYY-MM-DD' + 'HH:mm' → 本地时区下的 ISO 瞬间 */
export function combineLocal(dateKey: string, timeKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = timeKey.split(':').map(Number);
  return new Date(
    year ?? 1970,
    (month ?? 1) - 1,
    day ?? 1,
    hour ?? 0,
    minute ?? 0,
    0,
    0,
  ).toISOString();
}

export function addMinutesToTime(timeKey: string, minutes: number): string {
  const [hour, minute] = timeKey.split(':').map(Number);
  const total = (hour ?? 0) * 60 + (minute ?? 0) + minutes;
  const normalized = ((total % 1440) + 1440) % 1440;
  return `${pad(Math.floor(normalized / 60))}:${pad(normalized % 60)}`;
}

export function createEmptyFormState(defaults: EditorDefaults): EventFormState {
  const start = defaults.allDay ? new Date(`${defaults.startAt.slice(0, 10)}T00:00`) : new Date(defaults.startAt);
  const end = defaults.allDay ? new Date(`${defaults.endAt.slice(0, 10)}T00:00`) : new Date(defaults.endAt);

  return {
    title: '',
    description: '',
    location: '',
    categoryId: null,
    color: null,
    priority: 'normal',
    status: 'confirmed',
    allDay: defaults.allDay,
    startDate: dateKeyOf(start),
    startTime: timeKeyOf(start),
    endDate: dateKeyOf(end),
    endTime: timeKeyOf(end),
    tags: [],
    recurrenceEnabled: false,
    freq: 'WEEKLY',
    interval: 1,
    // byWeekday 与后端 RRULE 对齐：0 = 周日 … 6 = 周六
    byWeekday: [start.getDay()],
    recurrenceEnd: 'never',
    count: 10,
    until: dateKeyOf(end),
    remindMinutesBefore: 15,
  };
}

export function formStateFromOccurrence(
  occurrence: Occurrence,
  master: CalendarEvent | null,
): EventFormState {
  const start = occurrence.allDay
    ? { date: occurrence.startAt.slice(0, 10), time: '09:00' }
    : splitInstant(occurrence.startAt);
  const end = occurrence.allDay
    ? { date: occurrence.endAt.slice(0, 10), time: '10:00' }
    : splitInstant(occurrence.endAt);

  const rule = occurrence.rrule ?? master?.rrule ?? null;
  const fallbackWeekday = new Date(`${start.date}T00:00`).getDay();

  return {
    title: occurrence.title,
    description: occurrence.description,
    location: occurrence.location,
    categoryId: occurrence.categoryId,
    color: occurrence.color,
    priority: occurrence.priority,
    status: occurrence.status === 'cancelled' ? 'confirmed' : occurrence.status,
    allDay: occurrence.allDay,
    startDate: start.date,
    startTime: occurrence.allDay ? '09:00' : start.time,
    endDate: end.date,
    endTime: occurrence.allDay ? '10:00' : end.time,
    tags: [...occurrence.tags],
    recurrenceEnabled: rule !== null,
    freq: rule?.freq ?? 'WEEKLY',
    interval: rule?.interval ?? 1,
    byWeekday: rule?.byWeekday && rule.byWeekday.length > 0 ? [...rule.byWeekday] : [fallbackWeekday],
    recurrenceEnd: rule?.count !== undefined ? 'count' : rule?.until ? 'until' : 'never',
    count: rule?.count ?? 10,
    until: rule?.until ? rule.until.slice(0, 10) : end.date,
    remindMinutesBefore: occurrence.remindMinutesBefore,
  };
}

export interface FormValidation {
  payload: EventPayload | null;
  error: string | null;
}

export function buildRecurrenceRule(state: EventFormState): RecurrenceRule | null {
  if (!state.recurrenceEnabled) return null;

  const rule: RecurrenceRule = {
    freq: state.freq,
    interval: Math.max(1, Math.min(365, Math.round(state.interval) || 1)),
  };

  if (state.freq === 'WEEKLY') {
    const weekdays = [...new Set(state.byWeekday)].sort((a, b) => a - b);
    rule.byWeekday = weekdays.length > 0 ? weekdays : [1];
  }

  if (state.recurrenceEnd === 'count') {
    rule.count = Math.max(1, Math.min(500, Math.round(state.count) || 1));
  } else if (state.recurrenceEnd === 'until') {
    rule.until = state.until;
  }

  return rule;
}

/** 校验并生成请求体。错误信息直接面向用户，因此使用中文且可操作。 */
export function buildEventPayload(state: EventFormState): FormValidation {
  const title = state.title.trim();
  if (title.length === 0) return { payload: null, error: '请填写日程标题' };
  if (title.length > 120) return { payload: null, error: '标题不能超过 120 个字符' };

  let startAt: string;
  let endAt: string;

  if (state.allDay) {
    if (state.endDate < state.startDate) {
      return { payload: null, error: '全天日程的结束日期不能早于开始日期' };
    }
    startAt = state.startDate;
    endAt = state.endDate;
  } else {
    startAt = combineLocal(state.startDate, state.startTime);
    endAt = combineLocal(state.endDate, state.endTime);
    if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
      return { payload: null, error: '结束时间必须晚于开始时间' };
    }
  }

  if (state.recurrenceEnabled && state.recurrenceEnd === 'until' && state.until < startAt.slice(0, 10)) {
    return { payload: null, error: '重复结束日期不能早于开始日期' };
  }

  const payload: EventPayload = {
    title,
    description: state.description.trim(),
    location: state.location.trim(),
    categoryId: state.categoryId,
    priority: state.priority,
    status: state.status,
    allDay: state.allDay,
    startAt,
    endAt,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tags: state.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
    rrule: buildRecurrenceRule(state),
    color: state.color,
    remindMinutesBefore: state.remindMinutesBefore,
  };

  return { payload, error: null };
}

/**
 * 编辑重复日程的「整个序列」时，把用户改动的“时间差”套用到主序列上。
 * 用户改的是某一个实例，语义上应当平移整条序列，而不是把序列首日搬过去。
 */
export function shiftSeriesTimes(
  master: CalendarEvent,
  occurrence: Occurrence,
  payload: EventPayload,
): { startAt: string; endAt: string } {
  if (master.allDay || payload.allDay) {
    const masterStart = new Date(`${master.startAt.slice(0, 10)}T00:00`).getTime();
    const masterEnd = new Date(`${master.endAt.slice(0, 10)}T00:00`).getTime();
    const occurrenceStart = new Date(`${occurrence.startAt.slice(0, 10)}T00:00`).getTime();
    const nextStart = new Date(`${String(payload.startAt).slice(0, 10)}T00:00`).getTime();
    const deltaDays = Math.round((nextStart - occurrenceStart) / 86_400_000);
    const shift = deltaDays * 86_400_000;
    return {
      startAt: dateKeyOf(new Date(masterStart + shift)),
      endAt: dateKeyOf(new Date(masterEnd + shift)),
    };
  }

  const deltaMs = new Date(payload.startAt).getTime() - new Date(occurrence.startAt).getTime();
  return {
    startAt: new Date(new Date(master.startAt).getTime() + deltaMs).toISOString(),
    endAt: new Date(new Date(master.endAt).getTime() + deltaMs).toISOString(),
  };
}

export const FREQUENCY_UNIT_LABEL: Record<RecurrenceFrequency, string> = {
  DAILY: '天',
  WEEKLY: '周',
  MONTHLY: '月',
  YEARLY: '年',
};
