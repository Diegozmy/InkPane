/**
 * 语音助手设置的 HTTP 路由（控制台会话鉴权）。
 *
 * 与 `/api/display` 的写接口不同，语音设置校验失败沿用全局错误中间件的
 * `422 VALIDATION_FAILED`，前端按 `details[].path` 把错误标在对应字段上。
 */

import { Router } from 'express';
import { asyncHandler } from '../../http/async-handler.js';
import { requireUser } from '../../http/auth.js';
import { voiceUpdateSchema } from '../../domain/schemas.js';
import { getVoiceSettings, updateVoiceSettings } from './service.js';

export function createVoiceRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      res.json({ data: getVoiceSettings(requireUser(req).userId) });
    }),
  );

  router.put(
    '/',
    asyncHandler((req, res) => {
      const input = voiceUpdateSchema.parse(req.body);
      res.json({ data: updateVoiceSettings(input, requireUser(req).userId) });
    }),
  );

  return router;
}
