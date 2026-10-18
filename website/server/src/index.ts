/** 服务入口：初始化数据库、启动 HTTP 服务、注册优雅退出。 */

import type { Server } from 'node:http';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { closeDatabase, getDatabase } from './db/client.js';
import { isDatabaseEmpty, runMigrations, schemaVersion } from './db/migrations.js';
import { seedDemoData } from './db/seed.js';
import { ensureUtcAvailable } from './domain/time.js';
import { createApp } from './app.js';
import { startCourseSyncScheduler } from './modules/courses/scheduler.js';

let stopScheduler: (() => void) | null = null;

function shutdown(server: Server, signal: string): void {
  logger.info('收到退出信号，开始优雅关闭', { signal });
  stopScheduler?.();
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

function main(): void {
  try {
    ensureUtcAvailable();

    const db = getDatabase();
    runMigrations(db);

    if (config.seedOnEmpty && isDatabaseEmpty(db)) {
      const result = seedDemoData(db);
      if (result.seeded) {
        logger.info('已写入演示数据', {
          categories: result.categoryCount,
          events: result.eventCount,
        });
      }
    }

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

    // 课程自动同步：开启后按配置的间隔轮询学校系统
    stopScheduler = startCourseSyncScheduler();

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

main();
