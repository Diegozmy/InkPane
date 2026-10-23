/**
 * 设备的 HTTP 路由（只保留设备自身需要的拉屏与遥测）。
 *
 * 鉴权边界：
 * - /screen、/telemetry 必须带 X-Device-Token；
 * - 令牌只对应一台设备，进而解析出所属用户；
 * - 控制台管理接口在 /api/devices（会话鉴权）。
 */

import { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../../http/async-handler.js';
import { UnauthorizedError } from '../../http/errors.js';
import { deviceTelemetrySchema } from '../../domain/schemas.js';
import {
  authenticateDevice,
  getScreenForDevice,
  recordTelemetry,
  type AuthenticatedDevice,
} from '../devices/service.js';

export const DEVICE_TOKEN_HEADER = 'x-device-token';

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

  router.post(
    '/telemetry',
    requireDeviceToken,
    asyncHandler((req, res) => {
      const input = deviceTelemetrySchema.parse(req.body);
      res.json({ data: recordTelemetry(req.deviceAuth!.device.id, input) });
    }),
  );

  return router;
}
