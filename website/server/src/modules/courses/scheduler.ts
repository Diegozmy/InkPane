/**
 * 课程自动同步调度器。
 *
 * 设计取舍：不引入任务队列，只用一个分钟级的定时器按需触发。
 * 每次 tick 才读取每个用户的设置，因此改开关/间隔立即生效；
 * 每个用户独立串行，避免一个用户的慢请求阻塞其他人。
 */

import { getDatabase } from '../../db/client.js';
import { all } from '../../db/query.js';
import { logger } from '../../lib/logger.js';
import { latestSyncRun } from './service.js';
import { readCourseSyncSettings } from './settings.js';

const TICK_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 12_000;

const runningUsers = new Set<number>();
let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

export interface SyncTickResult {
  ran: boolean;
  reason: string;
  created?: number;
  updated?: number;
  removed?: number;
}

/** 手动触发一次同步；与调度器共用用户级运行标记，避免并发。 */
export async function runCourseSyncNow(
  userId: number,
): Promise<{ created: number; updated: number; removed: number; total: number }> {
  if (runningUsers.has(userId)) throw new Error('已有同步任务在运行中，请稍后再试');
  runningUsers.add(userId);
  try {
    const { importCourses } = await import('./service.js');
    const result = await importCourses(userId);
    return { created: result.created, updated: result.updated, removed: result.removed, total: result.slots.length };
  } finally {
    runningUsers.delete(userId);
  }
}

async function tickForUser(userId: number): Promise<SyncTickResult> {
  if (runningUsers.has(userId)) return { ran: false, reason: '上一轮同步尚未结束' };

  const db = getDatabase();
  const settings = readCourseSyncSettings(db, userId);
  if (!settings.autoSync) return { ran: false, reason: '自动同步未开启' };

  const last = latestSyncRun(db, userId);
  const intervalMs = settings.syncIntervalHours * 3_600_000;
  if (last?.finishedAt) {
    const elapsed = Date.now() - new Date(last.finishedAt).getTime();
    if (elapsed < intervalMs) {
      return { ran: false, reason: `距离上次成功同步仅 ${Math.round(elapsed / 60_000)} 分钟` };
    }
  }

  runningUsers.add(userId);
  try {
    const { importCourses } = await import('./service.js');
    const result = await importCourses(userId);
    return { ran: true, reason: 'ok', created: result.created, updated: result.updated, removed: result.removed };
  } catch (error) {
    // 自动同步失败不应该影响服务本身，只记录日志；上一次成功的日程保持不动
    logger.warn('自动同步课程失败，将在下一个周期重试', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ran: false, reason: error instanceof Error ? error.message : '同步失败' };
  } finally {
    runningUsers.delete(userId);
  }
}

async function tick(): Promise<void> {
  const db = getDatabase();
  const users = all<{ id: number }>(db, "SELECT id FROM users WHERE status = 'active'");
  // 串行执行，避免外部学校站点被并发请求打爆；用户规模是家庭/班级级。
  for (const user of users) {
    await tickForUser(Number(user.id));
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

/** 测试用：直接跑一次某个用户的 tick，不依赖定时器。 */
export const __tickForTesting = tickForUser;
