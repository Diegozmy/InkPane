import type { CalendarView, EventStatus, Priority } from '@/types';

export const PRIORITY_META: Record<
  Priority,
  { label: string; tone: 'neutral' | 'info' | 'warning' | 'danger' }
> = {
  low: { label: '低', tone: 'neutral' },
  normal: { label: '普通', tone: 'info' },
  high: { label: '高', tone: 'warning' },
  urgent: { label: '紧急', tone: 'danger' },
};

export const PRIORITY_ORDER: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

export const STATUS_META: Record<EventStatus, { label: string }> = {
  confirmed: { label: '已确认' },
  tentative: { label: '待定' },
  cancelled: { label: '已取消' },
};

export const VIEW_META: Record<CalendarView, { label: string; path: string }> = {
  month: { label: '月', path: '/calendar/month' },
  week: { label: '周', path: '/calendar/week' },
  day: { label: '日', path: '/calendar/day' },
};

export const REMINDER_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 0, label: '准时提醒' },
  { value: 5, label: '提前 5 分钟' },
  { value: 10, label: '提前 10 分钟' },
  { value: 15, label: '提前 15 分钟' },
  { value: 30, label: '提前 30 分钟' },
  { value: 60, label: '提前 1 小时' },
  { value: 120, label: '提前 2 小时' },
  { value: 1440, label: '提前 1 天' },
];

export const DURATION_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' },
  { value: 45, label: '45 分钟' },
  { value: 60, label: '1 小时' },
  { value: 90, label: '1.5 小时' },
  { value: 120, label: '2 小时' },
  { value: 180, label: '3 小时' },
];

/** 供用户挑选的分类色板（数据色，与应用强调色无关）。 */
export const PRESET_COLORS: readonly string[] = [
  '#3b6fd4',
  '#2f9e6e',
  '#0f766e',
  '#c08a20',
  '#d97706',
  '#d1554a',
  '#b7418a',
  '#6b5bd2',
  '#5b6b7f',
  '#8a6a4f',
];

export const WEEKDAY_OPTIONS: readonly { value: number; label: string; short: string }[] = [
  { value: 1, label: '周一', short: '一' },
  { value: 2, label: '周二', short: '二' },
  { value: 3, label: '周三', short: '三' },
  { value: 4, label: '周四', short: '四' },
  { value: 5, label: '周五', short: '五' },
  { value: 6, label: '周六', short: '六' },
  { value: 0, label: '周日', short: '日' },
];

export const FREQUENCY_OPTIONS: readonly {
  value: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  label: string;
}[] = [
  { value: 'DAILY', label: '每天' },
  { value: 'WEEKLY', label: '每周' },
  { value: 'MONTHLY', label: '每月' },
  { value: 'YEARLY', label: '每年' },
];

export const REMINDER_POLL_INTERVAL_MS = 30_000;
export const MAX_TAG_LENGTH = 30;
