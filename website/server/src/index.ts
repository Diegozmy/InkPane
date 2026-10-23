/** 服务入口：初始化数据库、启动 HTTP 服务、注册优雅退出。 */

import type { Server } from 'node:http';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { closeDatabase, getDatabase } from './db/client.js';
import { runMigrations, schemaVersion } from './db/migrations.js';
import { seedDemoData } from './db/seed.js';
import { countEvents } from './modules/events/repository.js';
import { ensureUtcAvailable } from './domain/time.js';
import { createApp } from './app.js';
import { bootstrapAdminFromEnv } from './modules/auth/service.js';
import { initializeSetupCode } from './modules/auth/setup-code.js';
import { cleanupSessions } from './modules/auth/sessions.js';
import { startCourseSyncScheduler } from './modules/courses/scheduler.js';
import { startWeatherScheduler } from './modules/weather/scheduler.js';

const stopHandlers: (() => void)[] = [];

function shutdown(server: Server, signal: string): void {
  logger.info('收到退出信号，开始优雅关闭', { signal });
  for (const stop of stopHandlers) stop();
  const forceExit = setTimeout(() => {
    logger.warn('关闭超时，强制退出');
    process.exit(1);
  }, 5000);
  forceExit.unref();

  server.close((error) => {
    if (error) logger.error('关闭 HTTP 服务出错', error);
    closeDatabase();
    logger.info('服务已停止');
    process.exit(error ? 1 : 0);
  });
}

async function main(): Promise<void> {
  try {
    ensureUtcAvailable();

    const db = getDatabase();
    runMigrations(db);

    const bootstrapped = await bootstrapAdminFromEnv(
      db,
      config.bootstrapAdminUsername,
      config.bootstrapAdminPassword,
    );
    if (bootstrapped) {
      logger.info('已通过环境变量初始化管理员', { userId: bootstrapped.id });
      if (config.seedOnEmpty && countEvents(db, bootstrapped.id) === 0) {
        const result = seedDemoData(db, bootstrapped.id);
        if (result.seeded) {
          logger.info('已写入演示数据', {
            categories: result.categoryCount,
            events: result.eventCount,
          });
        }
      }
    }

    // 首次初始化保护：仍需 setup 且要求验证码时，生成并打印一次 6 位码。
    initializeSetupCode(db);

    const app = createApp();
    const server = app.listen(config.port, config.host, () => {
      logger.info('InkPane 日程服务已启动', {
        url: `http://${config.host}:${config.port}`,
        env: config.nodeEnv,
        schemaVersion: schemaVersion(db),
        database: config.databaseFile,
        corsOrigins: config.corsOrigins,
      });
    });

    stopHandlers.push(startCourseSyncScheduler());
    stopHandlers.push(startWeatherScheduler());

    const sessionCleanup = setInterval(() => {
      try {
        cleanupSessions(db);
      } catch (error) {
        logger.warn('清理过期会话失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, 60 * 60 * 1000);
    sessionCleanup.unref();
    stopHandlers.push(() => clearInterval(sessionCleanup));

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`端口 ${config.port} 已被占用，请修改 .env 中的 PORT 或释放该端口`);
      } else {
        logger.error('HTTP 服务发生错误', error);
      }
      closeDatabase();
      process.exit(1);
    });

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => shutdown(server, signal));
    }

    process.on('unhandledRejection', (reason) => {
      logger.error('未处理的 Promise 拒绝', reason);
    });
    process.on('uncaughtException', (error) => {
      logger.error('未捕获的异常，进程即将退出', error);
      closeDatabase();
      process.exit(1);
    });
  } catch (error) {
    logger.error('服务启动失败', error);
    closeDatabase();
    process.exit(1);
  }
}

void main();
