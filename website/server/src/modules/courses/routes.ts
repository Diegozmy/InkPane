/** 课程同步的 HTTP 路由。 */

import { Router } from 'express';
import { getDatabase } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { SchoolPortalClient } from './client.js';
import { readCredentials, deleteCredentials, saveCredentials } from './credentials.js';
import {
  courseSyncStatus,
  credentialsInputSchema,
  importCourses,
  previewCourses,
  previewInputSchema,
  settingsPatchSchema,
  translatePortalError,
} from './service.js';
import { readCourseSyncSettings, writeCourseSyncSettings } from './settings.js';
import { runCourseSyncNow } from './scheduler.js';

export function createCoursesRouter(): Router {
  const router = Router();

  router.get(
    '/status',
    asyncHandler((_req, res) => {
      res.json({ data: courseSyncStatus() });
    }),
  );

  /* ---------------- 设置 ---------------- */

  router.get(
    '/settings',
    asyncHandler((_req, res) => {
      res.json({ data: readCourseSyncSettings(getDatabase()) });
    }),
  );

  router.patch(
    '/settings',
    asyncHandler((req, res) => {
      const patch = settingsPatchSchema.parse(req.body);
      res.json({ data: writeCourseSyncSettings(getDatabase(), patch) });
    }),
  );

  /* ---------------- 凭据 ---------------- */

  router.put(
    '/credentials',
    asyncHandler((req, res) => {
      const input = credentialsInputSchema.parse(req.body);
      saveCredentials(getDatabase(), {
        username: input.username,
        password: input.password,
        remember: input.remember ?? true,
      });
      res.json({ data: courseSyncStatus().credentials });
    }),
  );

  router.delete(
    '/credentials',
    asyncHandler((_req, res) => {
      res.json({ data: { removed: deleteCredentials(getDatabase()) } });
    }),
  );

  /** 只验证账号是否可用，不保存。用于「测试连接」按钮。 */
  router.post(
    '/test-login',
    asyncHandler(async (req, res) => {
      const input = credentialsInputSchema.parse(req.body);
      const settings = readCourseSyncSettings(getDatabase());
      const client = new SchoolPortalClient({ baseUrl: settings.baseUrl });
      try {
        await client.login({ username: input.username, password: input.password });
      } catch (error) {
        translatePortalError(error);
      }
      res.json({ data: { ok: true, baseUrl: settings.baseUrl } });
    }),
  );

  /* ---------------- 预览与导入 ---------------- */

  router.post(
    '/preview',
    asyncHandler(async (req, res) => {
      const input = previewInputSchema.parse(req.body);
      const inline =
        input.username && input.password
          ? { username: input.username, password: input.password }
          : undefined;
      const preview = await previewCourses({
        ...(inline ? { credentials: inline } : {}),
        ...(input.rawHtml !== undefined ? { rawHtml: input.rawHtml } : {}),
      });
      res.json({ data: preview });
    }),
  );

  router.post(
    '/import',
    asyncHandler(async (req, res) => {
      const input = previewInputSchema.parse(req.body);
      const inline =
        input.username && input.password
          ? { username: input.username, password: input.password }
          : undefined;
      const result = await importCourses({
        ...(inline ? { credentials: inline } : {}),
        ...(input.rawHtml !== undefined ? { rawHtml: input.rawHtml } : {}),
      });
      // 预览里的原始 HTML 不返回给前端，避免响应过大
      const { slots, termId, termName, termStartDate, totalWeeks, warnings, created, updated, removed, categoryId } =
        result;
      res.json({
        data: { slots, termId, termName, termStartDate, totalWeeks, warnings, created, updated, removed, categoryId },
      });
    }),
  );

  /** 手动触发一次完整同步（等价于自动同步跑一轮）。 */
  router.post(
    '/sync-now',
    asyncHandler(async (_req, res) => {
      const result = await runCourseSyncNow();
      res.json({ data: result });
    }),
  );

  /** 是否已保存凭据（不返回密码，只返回脱敏信息）。 */
  router.get(
    '/credentials',
    asyncHandler((_req, res) => {
      const stored = readCredentials(getDatabase());
      res.json({
        data: {
          configured: stored !== null,
          username: stored?.username ?? null,
          remember: stored?.remember ?? false,
          updatedAt: stored?.updatedAt ?? null,
        },
      });
    }),
  );

  return router;
}
