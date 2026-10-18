import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { type Express } from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import { config, PROJECT_ROOT } from './config.js';
import { logger } from './lib/logger.js';
import {
  accessLog,
  errorHandler,
  notFoundHandler,
  requestContext,
  securityHeaders,
} from './http/middleware.js';
import { createCategoriesRouter } from './modules/categories.js';
import { createEventsRouter, createOccurrencesRouter } from './modules/events/routes.js';
import { createRemindersRouter } from './modules/reminders.js';
import { createStatsRouter } from './modules/stats.js';
import { createCoursesRouter } from './modules/courses/routes.js';
import { createTodosRouter } from './modules/todos/routes.js';
import { createWeatherRouter } from './modules/weather/routes.js';
import { createDisplayRouter } from './modules/display/routes.js';
import { createDeviceRouter } from './modules/device/routes.js';
import { countAllEvents } from './modules/events/service.js';
import { getDatabase } from './db/client.js';
import { schemaVersion } from './db/migrations.js';

/**
 * 组装 Express 应用。
 * 与进程启动解耦，便于集成测试直接拿到 app 实例。
 */
export function createApp(): Express {
  const app = express();

  // 反向代理场景下仍能拿到真实客户端 IP
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      // 无 Origin 的请求（同源页面、curl、服务端调用）一律放行
      if (!origin) return callback(null, true);
      if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      logger.warn('CORS 拒绝来源', { origin });
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Device-Token'],
    exposedHeaders: ['X-Request-Id', 'ETag'],
    maxAge: 600,
  };

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          // 组件通过 style 属性注入 CSS 变量（日历网格定位），因此需要放行内联样式
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'", ...config.corsOrigins.filter((origin) => origin !== '*')],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(securityHeaders);
  app.use(cors(corsOptions));
  app.use(express.json({ limit: config.bodyLimit }));
  app.use(requestContext);
  app.use(accessLog);

  app.get('/api/health', (_req, res) => {
    res.json({
      data: {
        status: 'ok',
        env: config.nodeEnv,
        schemaVersion: safeSchemaVersion(),
        eventCount: safeCount(),
        uptimeSeconds: Math.round(process.uptime()),
        serverTime: new Date().toISOString(),
      },
    });
  });

  app.use('/api/categories', createCategoriesRouter());
  app.use('/api/events', createEventsRouter());
  app.use('/api/occurrences', createOccurrencesRouter());
  app.use('/api/stats', createStatsRouter());
  app.use('/api/reminders', createRemindersRouter());
  app.use('/api/courses', createCoursesRouter());
  app.use('/api/todos', createTodosRouter());
  app.use('/api/weather', createWeatherRouter());
  app.use('/api/display', createDisplayRouter());
  app.use('/api/device', createDeviceRouter());

  mountStaticApp(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

function safeCount(): number {
  try {
    return countAllEvents();
  } catch {
    return 0;
  }
}

function safeSchemaVersion(): number {
  try {
    return schemaVersion(getDatabase());
  } catch {
    return 0;
  }
}

/**
 * 生产模式下可以选择由本服务直接托管前端构建产物，
 * 开发时仍然保持前后端分离（Vite dev server + 代理）。
 */
function mountStaticApp(app: Express): void {
  if (!config.serveStatic) return;

  const webDist = resolve(PROJECT_ROOT, 'web', 'dist');
  if (!existsSync(webDist)) {
    logger.warn('SERVE_STATIC 已开启，但未找到前端构建产物，请先执行 npm run build:web', {
      expected: webDist,
    });
    return;
  }

  app.use(
    express.static(webDist, {
      index: false,
      maxAge: config.isProduction ? '1h' : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        if (/\.[0-9a-f]{8,}\.(js|css|woff2?)$/i.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  // SPA 回退：除 /api 外的所有路径都返回 index.html
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(resolve(webDist, 'index.html'));
  });
  logger.info('已启用静态资源托管', { directory: webDist });
}
