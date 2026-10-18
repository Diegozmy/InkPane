/**
 * 课程同步的凭据存储。
 *
 * 明文密码只在内存中短暂存在：落库的是本机密文盒的密文，
 * 对外接口只返回用户名与「是否已保存密码」，绝不回传密码本身。
 */

import { nowIso } from '../../lib/clock.js';
import type { SqliteDatabase } from '../../db/client.js';
import { get, run } from '../../db/query.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../lib/secret-box.js';

export const COURSE_SOURCE = 'yucai-ws8';

interface CredentialRow {
  id: number;
  source: string;
  username: string;
  secret: string;
  remember: number;
  updated_at: string;
}

export interface StoredCredentials {
  username: string;
  password: string;
  remember: boolean;
  updatedAt: string;
}

export function readCredentials(db: SqliteDatabase): StoredCredentials | null {
  const row = get<CredentialRow>(
    db,
    'SELECT id, source, username, secret, remember, updated_at FROM sync_credentials WHERE id = 1',
  );
  if (!row) return null;

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
    remember: row.remember === 1,
    updatedAt: row.updated_at,
  };
}

export function saveCredentials(
  db: SqliteDatabase,
  input: { username: string; password: string; remember: boolean },
): void {
  const timestamp = nowIso();
  run(
    db,
    `INSERT INTO sync_credentials (id, source, username, secret, remember, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       source = excluded.source,
       username = excluded.username,
       secret = excluded.secret,
       remember = excluded.remember,
       updated_at = excluded.updated_at`,
    [COURSE_SOURCE, input.username, encryptSecret(input.password), input.remember ? 1 : 0, timestamp],
  );
}

export function deleteCredentials(db: SqliteDatabase): boolean {
  return run(db, 'DELETE FROM sync_credentials WHERE id = 1').changes > 0;
}

export interface CredentialsSummary {
  username: string | null;
  hasPassword: boolean;
  passwordMask: string | null;
  remember: boolean;
  updatedAt: string | null;
}

/** 供前端展示的脱敏视图。 */
export function describeCredentials(db: SqliteDatabase): CredentialsSummary {
  const stored = readCredentials(db);
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
