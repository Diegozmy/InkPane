/** 浏览器通知封装：负责权限申请、去重与点击聚焦。 */

import type { ReminderItem } from '@/types';

export type PermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export function notificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function currentPermission(): PermissionState {
  if (!notificationSupported()) return 'unsupported';
  return Notification.permission as PermissionState;
}

export async function requestNotificationPermission(): Promise<PermissionState> {
  if (!notificationSupported()) return 'unsupported';
  try {
    const result = await Notification.requestPermission();
    return result as PermissionState;
  } catch {
    return 'denied';
  }
}

/** 已触发过的提醒 id 落到 localStorage，避免刷新页面后重复弹窗。 */
const FIRED_KEY = 'inkpane.firedReminders';
const MAX_FIRED_RECORDS = 400;

function readFired(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FIRED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeFired(ids: Set<string>): void {
  try {
    const trimmed = [...ids].slice(-MAX_FIRED_RECORDS);
    window.localStorage.setItem(FIRED_KEY, JSON.stringify(trimmed));
  } catch {
    // 隐私模式下 localStorage 可能不可写，忽略即可
  }
}

export function wasReminderFired(key: string): boolean {
  return readFired().has(key);
}

export function markReminderFired(key: string): void {
  const fired = readFired();
  fired.add(key);
  writeFired(fired);
}

export function clearFiredReminders(): void {
  try {
    window.localStorage.removeItem(FIRED_KEY);
  } catch {
    // 忽略
  }
}

export interface NotifyOptions {
  onClick?: () => void;
  /** 数据里的提醒时刻，用于构造唯一去重键；缺省时退化为按日程去重 */
  fireAt?: string;
}

/**
 * 弹出系统通知。
 * 返回 true 表示已用系统通知展示，false 表示需要调用方退化为页面内提示。
 */
export function showReminderNotification(item: ReminderItem, options: NotifyOptions = {}): boolean {
  if (!notificationSupported() || Notification.permission !== 'granted') return false;

  const start = new Date(item.startAt);
  const timeText = `${`${start.getHours()}`.padStart(2, '0')}:${`${start.getMinutes()}`.padStart(2, '0')}`;
  const bodyParts = [`${timeText} 开始`];
  if (item.location) bodyParts.push(item.location);

  try {
    const notification = new Notification(item.title, {
      body: bodyParts.join('，'),
      tag: `${item.id}@${options.fireAt}`,
      silent: false,
    });
    notification.onclick = () => {
      window.focus();
      options.onClick?.();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
