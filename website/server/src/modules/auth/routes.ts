/** 登录、退出、当前用户与首次初始化。 */

import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { getDatabase } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { originGuard, requireAuth } from '../../http/auth.js';
import { ForbiddenError, RateLimitedError, UnauthorizedError } from '../../http/errors.js';
import { logger } from '../../lib/logger.js';
import { RateLimiter } from '../../lib/rate-limit.js';
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
import {
  invalidateSetupCode,
  setupCodeRequired,
  verifySetupCode,
} from './setup-code.js';

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
    /** 初始化验证码；SETUP_REQUIRE_CODE=true 时必填 */
    code: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

const profileSchema = z.object({ displayName: z.string().trim().min(1).max(40) }).strict();
const passwordChangeSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
  .strict();

/* ------------------------------------------------------------------ *
 * 登录与初始化限流（进程内，够本地/家庭规模使用）
 * ------------------------------------------------------------------ */

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

/** 同一 IP 每 15 分钟最多尝试 5 次 `/api/setup`（成功一次后系统已有管理员，不再可用）。 */
const SETUP_MAX_ATTEMPTS = 5;
const SETUP_WINDOW_MS = 15 * 60 * 1000;

const loginLimiter = new RateLimiter({
  maxAttempts: MAX_FAILURES,
  windowMs: FAILURE_WINDOW_MS,
  blockMs: BLOCK_MS,
});

const setupLimiter = new RateLimiter({
  maxAttempts: SETUP_MAX_ATTEMPTS,
  windowMs: SETUP_WINDOW_MS,
});

function attemptKey(ip: string, username: string): string {
  return `${ip}|${username.trim().toLowerCase()}`;
}

function setupKey(ip: string): string {
  return ip;
}

export function __resetLoginRateLimitForTests(): void {
  loginLimiter.clear();
}

export function __resetSetupRateLimitForTests(): void {
  setupLimiter.clear();
}

function sessionResponse(user: ReturnType<typeof getAuthUser>, dbSetupRequired: boolean) {
  return { user, setupRequired: dbSetupRequired };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

export function createAuthRouter(): Router {
  const router = Router();
  // 登录/退出等写接口也要校验来源；GET /me 等不受影响。
  router.use(originGuard);

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const input = loginSchema.parse(req.body);
      const db = getDatabase();
      const key = attemptKey(req.ip ?? req.socket.remoteAddress ?? 'unknown', input.username);
      const decision = loginLimiter.check(key);
      if (decision.blocked) {
        throw new RateLimitedError(
          `登录失败次数过多，请 ${decision.retryAfterSeconds} 秒后再试`,
          decision.retryAfterSeconds,
        );
      }

      const user = await authenticate(db, input.username, input.password);
      if (!user) {
        // 旧语义：第 5 次失败即写入封禁，第 6 次请求直接 429。
        loginLimiter.hit(key, { blockAtLimit: true });
        throw new UnauthorizedError('用户名或密码错误');
      }
      loginLimiter.reset(key);
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
  // 公开写接口的来源校验：无 Origin 放行；GET /status 不受影响。
  router.use(originGuard);

  router.get(
    '/status',
    asyncHandler((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        data: {
          required: setupRequired(getDatabase()),
          codeRequired: setupCodeRequired(),
        },
      });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = setupSchema.parse(req.body);
      const db = getDatabase();
      const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

      const decision = setupLimiter.hit(setupKey(ip));
      if (decision.blocked) {
        throw new RateLimitedError(
          `初始化尝试次数过多，请 ${decision.retryAfterSeconds} 秒后再试`,
          decision.retryAfterSeconds,
        );
      }

      // 只在系统仍需初始化时校验验证码；否则交给 setupAdmin 返回 409，
      // 避免已经完成初始化的实例把错误从「已完成」变成「验证码错误」。
      if (setupRequired(db) && !verifySetupCode(input.code)) {
        throw new ForbiddenError('初始化验证码缺失或错误');
      }

      const user = await setupAdmin(db, input);
      invalidateSetupCode();
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
