/**
 * 课程同步的凭据存储。
 *
 * 明文密码只在内存中短暂存在：落库的是本机密文盒的密文，
 * 对外接口只返回用户名与「是否已保存密码」，绝不回传密码本身。
 * 勾选“不保存”时密码只进入进程内缓存，不写数据库。
 */

import { nowIso } from '../../lib/clock.js';
import type { SqliteDatabase } from '../../db/client.js';
import { get, run } from '../../db/query.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../lib/secret-box.js';

export const COURSE_SOURCE = 'yucai-ws8';
const EPHEMERAL_TTL_MS = 12 * 60 * 60 * 1000;

interface CredentialRow {
  user_id: number;
  source: string;
  username: string;
  secret: string;
  base_url: string;
  remember: number;
  updated_at: string;
}

export interface StoredCredentials {
  username: string;
  password: string;
  baseUrl: string;
  remember: boolean;
  updatedAt: string;
}

interface EphemeralCredentials {
  username: string;
  password: string;
  baseUrl: string;
  expiresAt: number;
}

const ephemeral = new Map<number, EphemeralCredentials>();

function purgeExpired(): void {
  const now = Date.now();
  for (const [userId, value] of ephemeral) {
    if (value.expiresAt <= now) ephemeral.delete(userId);
  }
}

export function rememberEphemeralCredentials(
  userId: number,
  input: { username: string; password: string; baseUrl: string },
): void {
  ephemeral.set(userId, {
    ...input,
    expiresAt: Date.now() + EPHEMERAL_TTL_MS,
  });
}

export function clearEphemeralCredentials(userId: number): void {
  ephemeral.delete(userId);
}

function readRow(db: SqliteDatabase, userId: number): CredentialRow | null {
  return (
    get<CredentialRow>(
      db,
      `SELECT user_id, source, username, secret, base_url, remember, updated_at
       FROM sync_credentials WHERE user_id = ?`,
      [userId],
    ) ?? null
  );
}

export function readCredentials(db: SqliteDatabase, userId: number): StoredCredentials | null {
  purgeExpired();
  const row = readRow(db, userId);
  if (row) {
    let password: string;
    try {
      password = decryptSecret(row.secret);
    } catch {
      // 密钥文件丢失或密文损坏时视为「未保存」，让用户重新输入，而不是让整个服务报错
      return null;
    }
    return {
      username: row.username,
      password,
      baseUrl: row.base_url,
      remember: row.remember === 1,
      updatedAt: row.updated_at,
    };
  }

  const cached = ephemeral.get(userId);
  if (!cached) return null;
  return {
    username: cached.username,
    password: cached.password,
    baseUrl: cached.baseUrl,
    remember: false,
    updatedAt: new Date(cached.expiresAt - EPHEMERAL_TTL_MS).toISOString(),
  };
}

export function saveCredentials(
  db: SqliteDatabase,
  userId: number,
  input: { username: string; password: string; baseUrl: string; remember: boolean },
): void {
  const timestamp = nowIso();
  run(
    db,
    `INSERT INTO sync_credentials (user_id, source, username, secret, base_url, remember, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       source = excluded.source,
       username = excluded.username,
       secret = excluded.secret,
       base_url = excluded.base_url,
       remember = excluded.remember,
       updated_at = excluded.updated_at`,
    [
      userId,
      COURSE_SOURCE,
      input.username,
      encryptSecret(input.password),
      input.baseUrl,
      input.remember ? 1 : 0,
      timestamp,
    ],
  );
}

export function deleteCredentials(db: SqliteDatabase, userId: number): boolean {
  clearEphemeralCredentials(userId);
  return run(db, 'DELETE FROM sync_credentials WHERE user_id = ?', [userId]).changes > 0;
}

export interface CredentialsSummary {
  username: string | null;
  hasPassword: boolean;
  passwordMask: string | null;
  remember: boolean;
  updatedAt: string | null;
}

/** 供前端展示的脱敏视图。 */
export function describeCredentials(db: SqliteDatabase, userId: number): CredentialsSummary {
  const stored = readCredentials(db, userId);
  if (!stored) {
    return { username: null, hasPassword: false, passwordMask: null, remember: false, updatedAt: null };
  }
  return {
    username: stored.username,
    hasPassword: true,
    passwordMask: maskSecret(stored.password),
    remember: stored.remember,
    updatedAt: stored.updatedAt,
  };
}
