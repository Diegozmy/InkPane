/**
 * 天气后台刷新。
 *
 * 设备拉屏仍然只读缓存；这里负责让“始终开着的桌面屏”在控制台没打开时
 * 也能拿到新天气。按用户独立刷新，一个用户失败不影响其他人。
 */

import { getDatabase } from '../../db/client.js';
import { all } from '../../db/query.js';
import { logger } from '../../lib/logger.js';
import { getWeatherSnapshot, weatherNeedsRefresh } from './service.js';

const TICK_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 8_000;

const inFlight = new Set<number>();
let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

async function tickForUser(userId: number): Promise<void> {
  if (inFlight.has(userId)) return;
  const db = getDatabase();
  if (!weatherNeedsRefresh(db, userId)) return;
  inFlight.add(userId);
  try {
    await getWeatherSnapshot(userId, db);
  } catch (error) {
    logger.warn('后台天气刷新失败', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    inFlight.delete(userId);
  }
}

async function tick(): Promise<void> {
  const db = getDatabase();
  const users = all<{ id: number }>(db, "SELECT id FROM users WHERE status = 'active'");
  for (const user of users) {
    await tickForUser(Number(user.id));
  }
}

export function startWeatherScheduler(): () => void {
  if (timer) return stopWeatherScheduler;

  startupTimer = setTimeout(() => {
    void tick();
  }, STARTUP_DELAY_MS);
  startupTimer.unref();

  timer = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  timer.unref();

  logger.info('天气后台刷新调度器已启动', { tickIntervalMs: TICK_INTERVAL_MS });
  return stopWeatherScheduler;
}

export function stopWeatherScheduler(): void {
  if (timer) clearInterval(timer);
  if (startupTimer) clearTimeout(startupTimer);
  timer = null;
  startupTimer = null;
}

/** 测试用：直接跑一次某个用户的刷新判断。 */
export const __tickForTesting = tickForUser;
