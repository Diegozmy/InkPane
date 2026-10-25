/**
 * 设备的 HTTP 路由。
 *
 * 鉴权边界：
 * - 所有接口必须带 X-Device-Token；令牌只对应一台设备，进而解析出所属用户；
 * - 读：`/screen`（拉屏）、`/context`（语音助手用的今日上下文）；
 * - 写：`/events`、`/todos`（供语音助手修改日程与待办）；
 * - 写接口按设备限流 20 次/60s，并记录 logger.info；
 * - 控制台管理接口在 /api/devices（会话鉴权）。
 */

import { Router, type Request, type RequestHandler } from 'express';
import { asyncHandler } from '../../http/async-handler.js';
import { RateLimitedError, UnauthorizedError } from '../../http/errors.js';
import { logger } from '../../lib/logger.js';
import { RateLimiter } from '../../lib/rate-limit.js';
import {
  deviceTelemetrySchema,
  eventCreateSchema,
  eventUpdateSchema,
  idParamSchema,
  todoCreateSchema,
  todoUpdateSchema,
} from '../../domain/schemas.js';
import {
  authenticateDevice,
  getScreenForDevice,
  recordTelemetry,
  type AuthenticatedDevice,
} from '../devices/service.js';
import { createEvent, deleteEvent, updateEvent } from '../events/service.js';
import { createTodo, deleteTodoById, updateTodoById } from '../todos/service.js';
import { getDeviceContext } from './context.js';

export const DEVICE_TOKEN_HEADER = 'x-device-token';

/** 设备写接口配额：每台设备 60 秒内最多 20 次写操作。 */
export const DEVICE_WRITE_MAX_ATTEMPTS = 20;
export const DEVICE_WRITE_WINDOW_MS = 60_000;

const deviceWriteLimiter = new RateLimiter({
  maxAttempts: DEVICE_WRITE_MAX_ATTEMPTS,
  windowMs: DEVICE_WRITE_WINDOW_MS,
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      deviceAuth?: AuthenticatedDevice;
    }
  }
}

/** 设备令牌校验中间件。 */
export const requireDeviceToken: RequestHandler = (req, _res, next) => {
  try {
    const auth = authenticateDevice(req.header(DEVICE_TOKEN_HEADER));
    req.deviceAuth = auth;
    next();
  } catch (error) {
    next(error instanceof Error ? error : new UnauthorizedError('设备令牌无效'));
  }
};

/** 设备写接口限流：在鉴权之后、解析请求体之前挡掉超频调用。 */
const requireDeviceWriteQuota: RequestHandler = (req, _res, next) => {
  const deviceId = req.deviceAuth?.device.id;
  if (deviceId === undefined) {
    next(new UnauthorizedError('设备令牌无效'));
    return;
  }
  const decision = deviceWriteLimiter.hit(`device:${deviceId}`);
  if (!decision.blocked) {
    next();
    return;
  }
  next(new RateLimitedError('设备写操作过于频繁，请稍后再试', decision.retryAfterSeconds));
};

/** 测试用：清空限流状态（进程内状态，不会随 app 重建自动归零）。 */
export function __resetDeviceWriteRateLimitForTests(): void {
  deviceWriteLimiter.clear();
}

function logDeviceWrite(
  req: Request,
  action: 'createEvent' | 'updateEvent' | 'deleteEvent' | 'createTodo' | 'updateTodo' | 'deleteTodo',
  fields: Record<string, unknown>,
): void {
  const auth = req.deviceAuth!;
  logger.info('设备写操作', {
    requestId: req.requestId,
    deviceId: auth.device.id,
    userId: auth.userId,
    action,
    ...fields,
  });
}

/** If-None-Match 可能是逗号分隔的列表，也允许 W/ 弱校验前缀与 *。 */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((part) => {
    const candidate = part.trim().replace(/^W\//i, '');
    return candidate === '*' || candidate === etag;
  });
}

export function createDeviceRouter(): Router {
  const router = Router();

  router.get(
    '/screen',
    requireDeviceToken,
    asyncHandler((req, res) => {
      const auth = req.deviceAuth!;
      const payload = getScreenForDevice(auth.userId, auth.device.id);
      res.setHeader('ETag', payload.etag);
      res.setHeader('Cache-Control', 'no-cache');
      if (etagMatches(req.header('if-none-match'), payload.etag)) {
        res.status(304).end();
        return;
      }
      res.json({ data: payload });
    }),
  );

  /** 今日上下文：语音助手在读写前先读它，避免凭记忆编造日程。 */
  router.get(
    '/context',
    requireDeviceToken,
    asyncHandler((req, res) => {
      const auth = req.deviceAuth!;
      res.json({ data: getDeviceContext(auth.userId, auth.device.id) });
    }),
  );

  router.post(
    '/telemetry',
    requireDeviceToken,
    asyncHandler((req, res) => {
      const input = deviceTelemetrySchema.parse(req.body);
      res.json({ data: recordTelemetry(req.deviceAuth!.device.id, input) });
    }),
  );

  /* ------------------------------ 写：日程 ------------------------------ */

  router.post(
    '/events',
    requireDeviceToken,
    requireDeviceWriteQuota,
    asyncHandler((req, res) => {
      const auth = req.deviceAuth!;
      const input = eventCreateSchema.parse(req.body);
      const event = createEvent(input, auth.userId);
      logDeviceWrite(req, 'createEvent', { eventId: event.id });
      res.status(201).json({ data: event });
    }),
  );

  router.patch(
    '/events/:id',
    requireDeviceToken,
    requireDeviceWriteQuota,
    asyncHandler((req, res) => {
      const auth = req.deviceAuth!;
      const { id } = idParamSchema.parse(req.params);
      const patch = eventUpdateSchema.parse(req.body);
      const event = updateEvent(id, patch, auth.userId);
      logDeviceWrite(req, 'updateEvent', { eventId: event.id });
      res.json({ data: event });
    }),
  );

  router.delete(
    '/events/:id',
    requireDeviceToken,
    requireDeviceWriteQuota,
    asyncHandler((req, res) => {
      const auth = req.deviceAuth!;
      const { id } = idParamSchema.parse(req.params);
      deleteEvent(id, auth.userId);
      logDeviceWrite(req, 'deleteEvent', { eventId: id });
      res.status(204).end();
    }),
  );

  /* ------------------------------ 写：待办 ------------------------------ */

  router.post(
    '/todos',
    requireDeviceToken,
    requireDeviceWriteQuota,
    asyncHandler((req, res) => {
      const auth = req.deviceAuth!;
      const input = todoCreateSchema.parse(req.body);
      const todo = createTodo(input, auth.userId);
      logDeviceWrite(req, 'createTodo', { todoId: todo.id });
      res.status(201).json({ data: todo });
    }),
  );

  router.patch(
    '/todos/:id',
    requireDeviceToken,
    requireDeviceWriteQuota,
    asyncHandler((req, res) => {
      const auth = req.deviceAuth!;
      const { id } = idParamSchema.parse(req.params);
      const patch = todoUpdateSchema.parse(req.body);
      const todo = updateTodoById(id, patch, auth.userId);
      logDeviceWrite(req, 'updateTodo', { todoId: todo.id });
      res.json({ data: todo });
    }),
  );

  router.delete(
    '/todos/:id',
    requireDeviceToken,
    requireDeviceWriteQuota,
    asyncHandler((req, res) => {
      const auth = req.deviceAuth!;
      const { id } = idParamSchema.parse(req.params);
      deleteTodoById(id, auth.userId);
      logDeviceWrite(req, 'deleteTodo', { todoId: id });
      res.status(204).end();
    }),
  );

  return router;
}
