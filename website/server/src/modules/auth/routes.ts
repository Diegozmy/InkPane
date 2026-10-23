/** 登录、退出、当前用户与首次初始化。 */

import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { getDatabase } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { requireAuth } from '../../http/auth.js';
import { RateLimitedError, UnauthorizedError } from '../../http/errors.js';
import { logger } from '../../lib/logger.js';
import { seedDemoData } from '../../db/seed.js';
import { timezoneSchema } from '../../domain/schemas.js';
import {
  authenticate,
  changeOwnPassword,
  getAuthUser,
  setupAdmin,
  setupRequired,
  updateDisplayName,
} from './service.js';
import {
  clearSessionCookie,
  createSession,
  readSessionToken,
  revokeSession,
  setSessionCookie,
  findSession,
} from './sessions.js';

const usernameSchema = z
  .string()
  .trim()
  .min(3, '用户名至少 3 位')
  .max(32, '用户名最多 32 位')
  .regex(/^[a-zA-Z0-9._-]+$/, '用户名只能包含字母、数字、点、下划线或短横线');

const passwordSchema = z.string().min(8, '密码至少 8 位').max(128, '密码最多 128 位');

const loginSchema = z
  .object({
    username: usernameSchema,
    password: z.string().min(1, '请输入密码').max(128),
  })
  .strict();

const setupSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    displayName: z.string().trim().max(40).optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();

const profileSchema = z.object({ displayName: z.string().trim().min(1).max(40) }).strict();
const passwordChangeSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .strict();

/* ------------------------------------------------------------------ *
 * 登录限流（内存，够本地/家庭规模使用）
 * ------------------------------------------------------------------ */

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

interface Attempt {
  failures: number;
  firstAt: number;
  blockedUntil: number;
}

const attempts = new Map<string, Attempt>();

function attemptKey(ip: string, username: string): string {
  return `${ip}|${username.trim().toLowerCase()}`;
}

function checkBlocked(key: string): void {
  const attempt = attempts.get(key);
  if (!attempt) return;
  if (attempt.blockedUntil > Date.now()) {
    const seconds = Math.max(1, Math.ceil((attempt.blockedUntil - Date.now()) / 1000));
    throw new RateLimitedError(`登录失败次数过多，请 ${seconds} 秒后再试`, seconds);
  }
  if (Date.now() - attempt.firstAt > FAILURE_WINDOW_MS) attempts.delete(key);
}

function recordFailure(key: string): void {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || now - current.firstAt > FAILURE_WINDOW_MS) {
    attempts.set(key, { failures: 1, firstAt: now, blockedUntil: 0 });
    return;
  }
  current.failures += 1;
  if (current.failures >= MAX_FAILURES) current.blockedUntil = now + BLOCK_MS;
}

export function __resetLoginRateLimitForTests(): void {
  attempts.clear();
}

function sessionResponse(user: ReturnType<typeof getAuthUser>, dbSetupRequired: boolean) {
  return { user, setupRequired: dbSetupRequired };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

export function createAuthRouter(): Router {
  const router = Router();

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const input = loginSchema.parse(req.body);
      const db = getDatabase();
      const key = attemptKey(req.ip ?? req.socket.remoteAddress ?? 'unknown', input.username);
      checkBlocked(key);

      const user = await authenticate(db, input.username, input.password);
      if (!user) {
        recordFailure(key);
        throw new UnauthorizedError('用户名或密码错误');
      }
      attempts.delete(key);
      const session = createSession(db, user.id, req.header('user-agent'));
      setSessionCookie(res, session.token);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ data: sessionResponse(user, setupRequired(db)) });
    }),
  );

  router.post(
    '/logout',
    asyncHandler((req, res) => {
      const db = getDatabase();
      const token = readSessionToken(req);
      if (token) {
        const session = findSession(db, token);
        if (session) revokeSession(db, session.sessionId);
      }
      clearSessionCookie(res);
      res.json({ data: { ok: true } });
    }),
  );

  router.get(
    '/me',
    requireAuth,
    asyncHandler((req, res) => {
      const db = getDatabase();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ data: sessionResponse(getAuthUser(db, req.auth!.userId), setupRequired(db)) });
    }),
  );

  router.patch(
    '/me',
    requireAuth,
    asyncHandler((req, res) => {
      const input = profileSchema.parse(req.body);
      res.json({ data: updateDisplayName(getDatabase(), req.auth!.userId, input.displayName) });
    }),
  );

  router.post(
    '/password',
    requireAuth,
    asyncHandler(async (req, res) => {
      const input = passwordChangeSchema.parse(req.body);
      await changeOwnPassword(
        getDatabase(),
        req.auth!.userId,
        input.currentPassword,
        input.newPassword,
        req.auth!.sessionId,
      );
      res.json({ data: { ok: true } });
    }),
  );

  return router;
}

export function createSetupRouter(): Router {
  const router = Router();

  router.get(
    '/status',
    asyncHandler((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ data: { required: setupRequired(getDatabase()) } });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = setupSchema.parse(req.body);
      const db = getDatabase();
      const user = await setupAdmin(db, input);
      const session = createSession(db, user.id, req.header('user-agent'));
      setSessionCookie(res, session.token);

      if (config.seedOnEmpty && !config.isTest) {
        try {
          seedDemoData(db, user.id);
        } catch (error) {
          logger.warn('初始化演示数据失败，不影响账号创建', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      res.status(201).json({ data: { user, setupRequired: false } });
    }),
  );

  return router;
}

/** 管理员创建用户的路由在 users 模块中使用；此处导出 schema 供复用。 */
export { usernameSchema, passwordSchema };
