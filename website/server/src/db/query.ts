/**
 * 轻量 SQL 执行辅助：缓存已编译语句、统一参数类型、集中类型断言。
 * 全部使用位置参数（?），避免不同驱动对命名参数前缀的处理差异。
 */

import type { StatementSync } from 'node:sqlite';
import type { SqliteDatabase } from './client.js';

export type SqlValue = string | number | bigint | null | Uint8Array;

const statementCache = new WeakMap<SqliteDatabase, Map<string, StatementSync>>();

function cached(db: SqliteDatabase, sql: string): StatementSync {
  let bucket = statementCache.get(db);
  if (!bucket) {
    bucket = new Map();
    statementCache.set(db, bucket);
  }
  const existing = bucket.get(sql);
  if (existing) return existing;
  const statement = db.prepare(sql);
  bucket.set(sql, statement);
  return statement;
}

export function all<T>(db: SqliteDatabase, sql: string, params: readonly SqlValue[] = []): T[] {
  return cached(db, sql).all(...params) as T[];
}

export function get<T>(
  db: SqliteDatabase,
  sql: string,
  params: readonly SqlValue[] = [],
): T | undefined {
  return cached(db, sql).get(...params) as T | undefined;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export function run(
  db: SqliteDatabase,
  sql: string,
  params: readonly SqlValue[] = [],
): RunResult {
  const result = cached(db, sql).run(...params);
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

export function scalar<T>(db: SqliteDatabase, sql: string, params: readonly SqlValue[] = []): T | undefined {
  const row = get<Record<string, unknown>>(db, sql, params);
  if (!row) return undefined;
  const values = Object.values(row);
  return values[0] as T | undefined;
}
