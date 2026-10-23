/**
 * app_settings 键值表的通用读写。
 *
 * 多用户之后主键是 (user_id, key)：显示布局、天气、课程同步设置都按用户隔离。
 * 值的序列化方式由调用方决定（这里只存字符串，JSON 由调用方自行 parse/stringify）。
 */

import type { SqliteDatabase } from '../db/client.js';
import { get, run } from '../db/query.js';
import { nowIso } from './clock.js';

interface SettingRow {
  value: string;
  updated_at: string;
}

export function readSettingRow(
  db: SqliteDatabase,
  userId: number,
  key: string,
): SettingRow | null {
  const row = get<SettingRow>(
    db,
    'SELECT value, updated_at FROM app_settings WHERE user_id = ? AND key = ?',
    [userId, key],
  );
  return row ?? null;
}

export function readSetting(db: SqliteDatabase, userId: number, key: string): string | null {
  return readSettingRow(db, userId, key)?.value ?? null;
}

/** 写入配置；同用户同键覆盖并刷新 updated_at。 */
export function writeSetting(
  db: SqliteDatabase,
  userId: number,
  key: string,
  value: string,
): void {
  run(
    db,
    `INSERT INTO app_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [userId, key, value, nowIso()],
  );
}

export function deleteSetting(db: SqliteDatabase, userId: number, key: string): boolean {
  return run(db, 'DELETE FROM app_settings WHERE user_id = ? AND key = ?', [userId, key]).changes > 0;
}

/** 某组键里最近一次更新时间，用于对外展示 updatedAt；都没有时返回 null。 */
export function latestSettingUpdate(
  db: SqliteDatabase,
  userId: number,
  keys: readonly string[],
): string | null {
  if (keys.length === 0) return null;
  const placeholders = keys.map(() => '?').join(', ');
  const row = get<{ updated_at: string | null }>(
    db,
    `SELECT MAX(updated_at) AS updated_at FROM app_settings WHERE user_id = ? AND key IN (${placeholders})`,
    [userId, ...keys],
  );
  return row?.updated_at ?? null;
}

/** 读取 JSON 配置；内容损坏时返回 null，交由调用方回退默认值。 */
export function readJsonSetting(db: SqliteDatabase, userId: number, key: string): unknown {
  const raw = readSetting(db, userId, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
