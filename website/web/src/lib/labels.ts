/** 展示层的文案与图标映射：优先级、天气图标、到期时间。 */

import type { IconName } from '@/components/ui/icon';
import { addDays, startOfDay } from 'date-fns';
import { toDateKey } from '@/lib/date';
import type { Priority, WeatherIcon } from '@/types';

/* ------------------------------ 优先级 ------------------------------ */

export const PRIORITY_LABEL: Record<Priority, string> = {
  urgent: '紧急',
  high: '高',
  normal: '普通',
  low: '低',
};

export const PRIORITY_ORDER: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export const PRIORITY_TONE: Record<Priority, BadgeTone> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'neutral',
  low: 'info',
};

/* ------------------------------ 天气 ------------------------------ */

export const WEATHER_ICON_NAME: Record<WeatherIcon, IconName> = {
  clear: 'sun',
  'partly-cloudy': 'cloud-sun',
  cloudy: 'cloud',
  fog: 'cloud-fog',
  drizzle: 'cloud-rain',
  rain: 'cloud-rain',
  snow: 'cloud-snow',
  thunderstorm: 'cloud-lightning',
};

export function weatherIconName(icon: WeatherIcon | undefined): IconName {
  return icon ? WEATHER_ICON_NAME[icon] : 'cloud';
}

/* ------------------------------ 到期时间 ------------------------------ */

export type DueState = 'overdue' | 'today' | 'tomorrow' | 'future' | 'none';

export interface DueInfo {
  state: DueState;
  label: string;
}

/** 把 YYYY-MM-DD 转成「今天 / 明天 / 逾期 2 天 / 10月24日」这类可读文案。 */
export function describeDue(dueDate: string | null): DueInfo {
  if (!dueDate) return { state: 'none', label: '' };
  const today = startOfDay(new Date());
  const todayKey = toDateKey(today);
  const tomorrowKey = toDateKey(addDays(today, 1));

  if (dueDate === todayKey) return { state: 'today', label: '今天到期' };
  if (dueDate === tomorrowKey) return { state: 'tomorrow', label: '明天到期' };
  if (dueDate < todayKey) {
    const diff = Math.round(
      (today.getTime() - new Date(`${dueDate}T00:00:00`).getTime()) / 86_400_000,
    );
    return { state: 'overdue', label: diff === 1 ? '逾期 1 天' : `逾期 ${diff} 天` };
  }
  const [, month, day] = dueDate.split('-');
  return { state: 'future', label: `${Number(month)} 月 ${Number(day)} 日` };
}

/** ISO 时间 → 「刚刚 / 3 分钟前 / 12:30」。 */
export function describeUpdatedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const diffMinutes = Math.round((Date.now() - time) / 60_000);
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  return new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
