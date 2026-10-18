/**
 * SQLite 连接管理。
 *
 * 使用 Node 内置的 node:sqlite（Node >= 22.5），因此整个项目零原生依赖，
 * 无需 node-gyp / Visual Studio 即可安装。所有 SQL 访问都经由本模块，
 * 未来若要换成 better-sqlite3 只需改这一个文件。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export type SqliteDatabase = DatabaseSync;

let instance: SqliteDatabase | null = null;
let activeFile: string | null = null;

/** SQLite 只接受 null / number / bigint / string / Uint8Array，布尔必须显式转换。 */
export function bool(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

export function fromBool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function applyPragmas(db: SqliteDatabase): void {
  // WAL 让读写并发更稳；内存库会忽略并保持 memory 模式。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA temp_store = MEMORY');
}

export function openDatabase(filePath: string = config.databaseFile): SqliteDatabase {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(resolve(filePath)), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  applyPragmas(db);
  logger.debug('SQLite 连接已建立', { file: filePath });
  return db;
}

/** 获取进程内单例连接。 */
export function getDatabase(): SqliteDatabase {
  if (!instance) {
    instance = openDatabase();
    activeFile = config.databaseFile;
  }
  return instance;
}

/** 当前连接对应的数据库文件路径（内存库为 ':memory:'）。 */
export function activeDatabaseFile(): string {
  if (activeFile !== null) return activeFile;
  return config.databaseFile;
}

export function closeDatabase(): void {
  if (!instance) return;
  try {
    instance.close();
  } catch (error) {
    logger.warn('关闭 SQLite 连接时出错', { error: String(error) });
  }
  instance = null;
  activeFile = null;
}

/** 在事务中执行；抛错自动回滚。 */
export function transaction<T>(db: SqliteDatabase, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      logger.error('事务回滚失败', rollbackError);
    }
    throw error;
  }
}

/** 单元测试用：把连接替换成给定的内存库。 */
export function setDatabaseForTesting(db: SqliteDatabase | null): void {
  instance = db;
  activeFile = db === null ? null : ':memory:';
}
