import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { REMINDER_POLL_INTERVAL_MS } from '@/lib/constants';
import {
  currentPermission,
  markReminderFired,
  requestNotificationPermission,
  showReminderNotification,
  wasReminderFired,
  type PermissionState,
} from '@/lib/notify';
import { toast, useUiStore } from '@/store/ui-store';
import { formatTime } from '@/lib/date';
import type { ReminderItem } from '@/types';

export interface ReminderController {
  permission: PermissionState;
  requestPermission: () => Promise<PermissionState>;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  /** 最近一次轮询发现的提醒，用于设置页展示“提醒渠道是否通畅” */
  lastCheckedAt: Date | null;
  lastCount: number;
}

/**
 * 提醒调度器。
 *
 * 采用前端轮询而不是服务端推送：部署时无需 WebSocket 或推送证书，
 * 同时通过 localStorage 去重，刷新页面不会重复弹窗。
 */
export function useReminderScheduler(): ReminderController {
  const enabled = useUiStore((state) => state.remindersEnabled);
  const setEnabled = useUiStore((state) => state.setRemindersEnabled);
  const [permission, setPermission] = useState<PermissionState>(() => currentPermission());
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);
  const [lastCount, setLastCount] = useState(0);

  const requestPermission = useCallback(async (): Promise<PermissionState> => {
    const next = await requestNotificationPermission();
    setPermission(next);
    if (next === 'granted') toast.success('已开启系统通知', '到点会收到提醒');
    else if (next === 'denied') toast.error('通知权限被拒绝', { description: '可在浏览器地址栏的站点设置中重新开启' });
    return next;
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    let disposed = false;

    const deliver = (item: ReminderItem): void => {
      const key = `${item.id}@${item.fireAt}`;
      if (wasReminderFired(key)) return;
      markReminderFired(key);

      const shown = showReminderNotification(item, { fireAt: item.fireAt });
      if (!shown) {
        const start = new Date(item.startAt);
        toast.info(`日程提醒：${item.title}`, `${formatTime(start)} 开始${item.location ? ` · ${item.location}` : ''}`);
      }
    };

    const tick = async (): Promise<void> => {
      try {
        const items = await api.dueReminders({ windowMinutes: 30 });
        if (disposed) return;
        setLastCheckedAt(new Date());
        setLastCount(items.length);
        for (const item of items) deliver(item);
      } catch {
        // 轮询失败可能是后端短暂不可用，下一轮会重试，不打扰用户
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), REMINDER_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [enabled]);

  useEffect(() => {
    const sync = (): void => setPermission(currentPermission());
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  return { permission, requestPermission, enabled, setEnabled, lastCheckedAt, lastCount };
}
