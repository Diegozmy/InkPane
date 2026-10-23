/** 控制台鉴权中间件：会话、角色与 CSRF 来源校验。 */

import type { Request, RequestHandler } from 'express';
import type { SqliteDatabase } from '../db/client.js';
import { getDatabase } from '../db/client.js';
import { config } from '../config.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';
import {
  findSession,
  readSessionToken,
  type SessionUser,
} from '../modules/auth/sessions.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: SessionUser;
    }
  }
}

function sessionFrom(req: Request, db: SqliteDatabase): SessionUser | null {
  const token = readSessionToken(req);
  if (!token) return null;
  return findSession(db, token);
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const session = sessionFrom(req, getDatabase());
  if (!session) {
    next(new UnauthorizedError('请先登录'));
    return;
  }
  req.auth = session;
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(new UnauthorizedError('请先登录'));
    return;
  }
  if (req.auth.role !== 'admin') {
    next(new ForbiddenError('需要管理员权限'));
    return;
  }
  next();
};

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedOrigin(req: Request, origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const allowed = new Set(
    [...config.corsOrigins, config.publicOrigin]
      .filter(Boolean)
      .map((item) => normalizeOrigin(item))
      .filter((item): item is string => item !== null),
  );
  if (allowed.has(normalized)) return true;
  // 同源部署/开发代理：Origin 的 host 与请求 Host 相同即可。
  try {
    const parsed = new URL(origin);
    return parsed.host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 带 Cookie 的写请求必须来自已知来源。
 * 无 Origin 的请求（curl、设备、服务端调用）放行；浏览器跨站 POST 会带 Origin，从而被挡住。
 */
export const csrfGuard: RequestHandler = (req, _res, next) => {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    next();
    return;
  }
  const origin = req.header('origin');
  if (!origin || isAllowedOrigin(req, origin)) {
    next();
    return;
  }
  next(new ForbiddenError('请求来源不被允许'));
};

/** 登录/初始化路由用：不抛错，只让调用方知道当前是否已有会话。 */
export function optionalSession(req: Request, db: SqliteDatabase = getDatabase()): SessionUser | null {
  return sessionFrom(req, db);
}

export function requireUser(req: Request): SessionUser {
  if (!req.auth) throw new UnauthorizedError('请先登录');
  return req.auth;
}

export function assertAdmin(req: Request): void {
  if (!req.auth) throw new UnauthorizedError('请先登录');
  if (req.auth.role !== 'admin') throw new ForbiddenError('需要管理员权限');
}

export type { SessionUser };
