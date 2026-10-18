/**
 * 设备的 HTTP 路由。
 *
 * 鉴权边界：
 * - 设备拉取接口（/screen、/telemetry）必须带 X-Device-Token；
 * - 控制台管理接口（/status、/settings、/token）免鉴权，仅在服务端本机使用。
 * 不接受把令牌放在 query 参数里，避免出现在访问日志中。
 */

import { Router, type RequestHandler } from 'express';
import { getDatabase } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { UnauthorizedError } from '../../http/errors.js';
import { deviceSettingsSchema, deviceTelemetrySchema } from '../../domain/schemas.js';
import { readDeviceToken } from './settings.js';
import {
  getDeviceScreen,
  getDeviceStatus,
  getDeviceToken,
  recordDeviceTelemetry,
  regenerateDeviceToken,
  updateDeviceSettings,
} from './service.js';

export const DEVICE_TOKEN_HEADER = 'x-device-token';

/** 设备令牌校验中间件。 */
export const requireDeviceToken: RequestHandler = (req, _res, next) => {
  try {
    const provided = req.header(DEVICE_TOKEN_HEADER)?.trim();
    const expected = readDeviceToken(getDatabase());
    if (!provided || provided !== expected) {
      throw new UnauthorizedError('设备令牌无效');
    }
    next();
  } catch (error) {
    next(error);
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
      const payload = getDeviceScreen();
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
      res.json({ data: recordDeviceTelemetry(input) });
    }),
  );

  router.get(
    '/status',
    asyncHandler((_req, res) => {
      res.json({ data: getDeviceStatus() });
    }),
  );

  router.get(
    '/token',
    asyncHandler((_req, res) => {
      res.json({ data: { token: getDeviceToken() } });
    }),
  );

  router.post(
    '/token',
    asyncHandler((_req, res) => {
      res.json({ data: { token: regenerateDeviceToken() } });
    }),
  );

  router.put(
    '/settings',
    asyncHandler((req, res) => {
      const input = deviceSettingsSchema.parse(req.body);
      res.json({ data: updateDeviceSettings(input) });
    }),
  );

  return router;
}
