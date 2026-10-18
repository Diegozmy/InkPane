/**
 * 课程自动同步调度器。
 *
 * 设计取舍：不引入任务队列，只用一个分钟级的定时器按需触发。
 * 每次 tick 才读取设置，因此用户在界面上改开关/间隔会立即生效，不需要重启服务；
 * 同时用运行中的标记防止上一轮还没跑完就又启动一轮。
 */

import { getDatabase } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { latestSyncRun } from './service.js';
import { readCourseSyncSettings } from './settings.js';

const TICK_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 12_000;

let running = false;
let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

export interface SyncTickResult {
  ran: boolean;
  reason: string;
  created?: number;
  updated?: number;
  removed?: number;
}

/** 手动触发一次同步；与调度器共用运行中标记，避免并发。 */
export async function runCourseSyncNow(): Promise<{ created: number; updated: number; removed: number; total: number }> {
  if (running) throw new Error('已有同步任务在运行中，请稍后再试');
  running = true;
  try {
    const { importCourses } = await import('./service.js');
    const result = await importCourses();
    return { created: result.created, updated: result.updated, removed: result.removed, total: result.slots.length };
  } finally {
    running = false;
  }
}

async function tick(): Promise<SyncTickResult> {
  if (running) return { ran: false, reason: '上一轮同步尚未结束' };

  const db = getDatabase();
  const settings = readCourseSyncSettings(db);
  if (!settings.autoSync) return { ran: false, reason: '自动同步未开启' };

  const last = latestSyncRun(db);
  const intervalMs = settings.syncIntervalHours * 3_600_000;
  if (last?.finishedAt) {
    const elapsed = Date.now() - new Date(last.finishedAt).getTime();
    if (elapsed < intervalMs) {
      return { ran: false, reason: `距离上次成功同步仅 ${Math.round(elapsed / 60_000)} 分钟` };
    }
  }

  running = true;
  try {
    const { importCourses } = await import('./service.js');
    const result = await importCourses();
    return { ran: true, reason: 'ok', created: result.created, updated: result.updated, removed: result.removed };
  } catch (error) {
    // 自动同步失败不应该影响服务本身，只记录日志；上一次成功的日程保持不动
    logger.warn('自动同步课程失败，将在下一个周期重试', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ran: false, reason: error instanceof Error ? error.message : '同步失败' };
  } finally {
    running = false;
  }
}

export function startCourseSyncScheduler(): () => void {
  if (timer) return stopCourseSyncScheduler;

  // 启动后先等一会儿再跑，避免和建库、迁移抢时间
  startupTimer = setTimeout(() => {
    void tick();
  }, STARTUP_DELAY_MS);
  startupTimer.unref();

  timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  timer.unref();

  logger.info('课程自动同步调度器已启动', { tickIntervalMs: TICK_INTERVAL_MS });
  return stopCourseSyncScheduler;
}

export function stopCourseSyncScheduler(): void {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
}

/** 测试用：直接跑一次 tick，不依赖定时器。 */
export const __tickForTesting = tick;
