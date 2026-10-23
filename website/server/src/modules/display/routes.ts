/**
 * 屏幕布局的 HTTP 路由。
 *
 * 与其它模块不同，布局校验失败按契约返回 400 + VALIDATION_FAILED（而不是默认的 422），
 * 前端布局编辑器据此把错误标在对应模块上。
 */

import { Router } from 'express';
import { getDatabase } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { requireUser } from '../../http/auth.js';
import { AppError } from '../../http/errors.js';
import { displayUpdateSchema, type DisplayUpdateInput } from '../../domain/schemas.js';
import { getDisplayConfig, updateDisplayConfig } from './service.js';
import { buildDeviceScreenPayload } from '../device/screen.js';

/** PUT /api/display 专用：结构/几何校验失败统一映射为 400 VALIDATION_FAILED。 */
function parseDisplayUpdate(body: unknown): DisplayUpdateInput {
  const result = displayUpdateSchema.safeParse(body);
  if (!result.success) {
    throw new AppError('显示设置校验未通过', 400, 'VALIDATION_FAILED', {
      details: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    });
  }
  return result.data;
}

export function createDisplayRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      res.json({ data: getDisplayConfig(requireUser(req).userId) });
    }),
  );

  router.put(
    '/',
    asyncHandler((req, res) => {
      const input = parseDisplayUpdate(req.body);
      res.json({ data: updateDisplayConfig(input, requireUser(req).userId) });
    }),
  );

  /** 控制台预览：与设备拉取到的结构完全一致，但不需要设备令牌、也不触发联网刷新。 */
  router.get(
    '/screen',
    asyncHandler((req, res) => {
      res.json({ data: buildDeviceScreenPayload(requireUser(req).userId, getDatabase(), new Date()) });
    }),
  );

  return router;
}
