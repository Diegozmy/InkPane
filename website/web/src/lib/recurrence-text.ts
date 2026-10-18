/** 重复规则的文案描述（与后端 describeRecurrence 保持一致的措辞）。 */

import type { RecurrenceRule } from '@/types';

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const FREQUENCY_LABELS: Record<RecurrenceRule['freq'], string> = {
  DAILY: '每天',
  WEEKLY: '每周',
  MONTHLY: '每月',
  YEARLY: '每年',
};

const FREQUENCY_UNITS: Record<RecurrenceRule['freq'], string> = {
  DAILY: '天',
  WEEKLY: '周',
  MONTHLY: '月',
  YEARLY: '年',
};

export function describeRecurrence(rule: RecurrenceRule | null | undefined): string {
  if (!rule) return '不重复';

  const interval = Math.max(1, rule.interval || 1);
  let text = interval > 1 ? `每 ${interval} ${FREQUENCY_UNITS[rule.freq]}` : FREQUENCY_LABELS[rule.freq];

  if (rule.freq === 'WEEKLY' && rule.byWeekday && rule.byWeekday.length > 0) {
    const labels = [...new Set(rule.byWeekday)]
      .sort((a, b) => ((a - 1 + 7) % 7) - ((b - 1 + 7) % 7))
      .map((day) => WEEKDAY_LABELS[day] ?? '')
      .filter(Boolean);
    if (labels.length > 0) text += ` ${labels.join('、')}`;
  }

  if (rule.count !== undefined) text += `，共 ${rule.count} 次`;
  else if (rule.until) text += `，至 ${rule.until.slice(0, 10)}`;

  return text;
}

export function describeReminder(minutes: number | null): string {
  if (minutes === null) return '不提醒';
  if (minutes === 0) return '准时提醒';
  if (minutes < 60) return `提前 ${minutes} 分钟`;
  if (minutes < 1440) {
    const hours = minutes / 60;
    return `提前 ${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
  }
  const days = minutes / 1440;
  return `提前 ${Number.isInteger(days) ? days : days.toFixed(1)} 天`;
}
