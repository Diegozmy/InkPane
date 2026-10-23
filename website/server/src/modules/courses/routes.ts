/** 课程同步的 HTTP 路由。 */

import { Router } from 'express';
import { getDatabase } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { requireUser } from '../../http/auth.js';
import { SchoolPortalClient } from './client.js';
import {
  readCredentials,
  deleteCredentials,
  rememberEphemeralCredentials,
  saveCredentials,
} from './credentials.js';
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
    asyncHandler((req, res) => {
      res.json({ data: courseSyncStatus(requireUser(req).userId) });
    }),
  );

  /* ---------------- 设置 ---------------- */

  router.get(
    '/settings',
    asyncHandler((req, res) => {
      res.json({ data: readCourseSyncSettings(getDatabase(), requireUser(req).userId) });
    }),
  );

  router.patch(
    '/settings',
    asyncHandler((req, res) => {
      const patch = settingsPatchSchema.parse(req.body);
      const db = getDatabase();
      const userId = requireUser(req).userId;
      const before = readCourseSyncSettings(db, userId);
      const updated = writeCourseSyncSettings(db, userId, patch);
      // 地址变更后绝不能让旧密码被发往新地址；要求用户重新输入凭据。
      if (patch.baseUrl !== undefined && patch.baseUrl !== before.baseUrl) {
        deleteCredentials(db, userId);
      }
      res.json({ data: updated });
    }),
  );

  /* ---------------- 凭据 ---------------- */

  router.put(
    '/credentials',
    asyncHandler((req, res) => {
      const input = credentialsInputSchema.parse(req.body);
      const db = getDatabase();
      const userId = requireUser(req).userId;
      const settings = readCourseSyncSettings(db, userId);
      const remember = input.remember ?? true;
      if (remember) {
        saveCredentials(db, userId, {
          username: input.username,
          password: input.password,
          baseUrl: settings.baseUrl,
          remember: true,
        });
      } else {
        // 不保存到磁盘：清掉旧凭据，只保留进程内 12 小时缓存。
        deleteCredentials(db, userId);
        rememberEphemeralCredentials(userId, {
          username: input.username,
          password: input.password,
          baseUrl: settings.baseUrl,
        });
      }
      res.json({ data: courseSyncStatus(userId, db).credentials });
    }),
  );

  router.delete(
    '/credentials',
    asyncHandler((req, res) => {
      res.json({ data: { removed: deleteCredentials(getDatabase(), requireUser(req).userId) } });
    }),
  );

  /** 只验证账号是否可用，不保存。用于「测试连接」按钮。 */
  router.post(
    '/test-login',
    asyncHandler(async (req, res) => {
      const input = credentialsInputSchema.parse(req.body);
      const db = getDatabase();
      const userId = requireUser(req).userId;
      const settings = readCourseSyncSettings(db, userId);
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
      const preview = await previewCourses(requireUser(req).userId, {
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
      const result = await importCourses(requireUser(req).userId, {
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
    asyncHandler(async (req, res) => {
      const result = await runCourseSyncNow(requireUser(req).userId);
      res.json({ data: result });
    }),
  );

  /** 是否已保存凭据（不返回密码，只返回脱敏信息）。 */
  router.get(
    '/credentials',
    asyncHandler((req, res) => {
      const stored = readCredentials(getDatabase(), requireUser(req).userId);
      res.json({
        data: {
          configured: stored !== null,
          ...courseSyncStatus(requireUser(req).userId).credentials,
        },
      });
    }),
  );

  return router;
}
