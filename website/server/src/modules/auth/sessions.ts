/** 控制台会话：随机令牌只下发一次，数据库只保存 SHA-256。 */

import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { SqliteDatabase } from '../../db/client.js';
import { get, run } from '../../db/query.js';
import { config } from '../../config.js';
import { nowIso } from '../../lib/clock.js';

export const SESSION_COOKIE = 'inkpane_session';
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface SessionUser {
  sessionId: number;
  userId: number;
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  status: 'pending_setup' | 'active' | 'disabled';
  expiresAt: string;
  revokedAt: string | null;
}

interface SessionRow {
  session_id: number;
  user_id: number;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string;
  username: string;
  display_name: string;
  role: 'admin' | 'user';
  status: 'pending_setup' | 'active' | 'disabled';
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(
  db: SqliteDatabase,
  userId: number,
  userAgent?: string,
): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString('base64url');
  const createdAt = nowIso();
  const expiresAt = new Date(
    Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  run(
    db,
    `INSERT INTO sessions (user_id, token_hash, created_at, last_used_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, hashSessionToken(token), createdAt, createdAt, expiresAt, userAgent ?? null],
  );
  return { token, expiresAt };
}

export function findSession(db: SqliteDatabase, token: string): SessionUser | null {
  const row = get<SessionRow>(
    db,
    `SELECT s.id AS session_id, s.user_id, s.token_hash, s.expires_at, s.revoked_at,
            s.last_used_at, u.username, u.display_name, u.role, u.status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    [hashSessionToken(token)],
  );
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (row.status !== 'active') return null;

  const lastUsed = new Date(row.last_used_at).getTime();
  if (!Number.isFinite(lastUsed) || Date.now() - lastUsed > TOUCH_INTERVAL_MS) {
    run(db, 'UPDATE sessions SET last_used_at = ? WHERE id = ?', [nowIso(), row.session_id]);
  }

  return {
    sessionId: Number(row.session_id),
    userId: Number(row.user_id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function revokeSession(db: SqliteDatabase, sessionId: number): void {
  run(db, 'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
    nowIso(),
    sessionId,
  ]);
}

export function revokeUserSessions(
  db: SqliteDatabase,
  userId: number,
  exceptSessionId?: number,
): void {
  if (exceptSessionId === undefined) {
    run(db, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [
      nowIso(),
      userId,
    ]);
    return;
  }
  run(
    db,
    'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
    [nowIso(), userId, exceptSessionId],
  );
}

export function cleanupSessions(db: SqliteDatabase): number {
  const now = nowIso();
  return run(
    db,
    `DELETE FROM sessions
     WHERE expires_at <= ?
        OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
    [now, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()],
  ).changes;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

export function readSessionToken(req: Request): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
  });
}
