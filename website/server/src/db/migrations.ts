/**
 * 版本化数据库迁移。
 * 使用 SQLite 内置的 PRAGMA user_version 记录当前结构版本，幂等且可重复执行。
 */

import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { SqliteDatabase } from './client.js';

interface Migration {
  version: number;
  name: string;
  up: (db: SqliteDatabase) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          name        TEXT    NOT NULL UNIQUE,
          color       TEXT    NOT NULL,
          icon        TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT    NOT NULL,
          updated_at  TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          title                  TEXT    NOT NULL,
          description            TEXT    NOT NULL DEFAULT '',
          location               TEXT    NOT NULL DEFAULT '',
          category_id            INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          priority               TEXT    NOT NULL DEFAULT 'normal'
                                   CHECK (priority IN ('low','normal','high','urgent')),
          status                 TEXT    NOT NULL DEFAULT 'confirmed'
                                   CHECK (status IN ('confirmed','tentative','cancelled')),
          all_day                INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
          start_at               TEXT    NOT NULL,
          end_at                 TEXT    NOT NULL,
          timezone               TEXT    NOT NULL DEFAULT 'UTC',
          tags                   TEXT    NOT NULL DEFAULT '[]',
          rrule                  TEXT,
          color                  TEXT,
          remind_minutes_before  INTEGER,
          created_at             TEXT    NOT NULL,
          updated_at             TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS event_overrides (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id       INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          occurrence_key TEXT    NOT NULL,
          cancelled      INTEGER NOT NULL DEFAULT 0 CHECK (cancelled IN (0,1)),
          title          TEXT,
          description    TEXT,
          location       TEXT,
          priority       TEXT,
          start_at       TEXT,
          end_at         TEXT,
          all_day        INTEGER CHECK (all_day IS NULL OR all_day IN (0,1)),
          category_id    INTEGER,
          tags           TEXT,
          created_at     TEXT    NOT NULL,
          updated_at     TEXT    NOT NULL,
          UNIQUE (event_id, occurrence_key)
        );

        CREATE INDEX IF NOT EXISTS idx_events_start_at    ON events (start_at);
        CREATE INDEX IF NOT EXISTS idx_events_category    ON events (category_id);
        CREATE INDEX IF NOT EXISTS idx_events_status      ON events (status);
        CREATE INDEX IF NOT EXISTS idx_overrides_event    ON event_overrides (event_id);
        CREATE INDEX IF NOT EXISTS idx_overrides_event_key ON event_overrides (event_id, occurrence_key);
        CREATE INDEX IF NOT EXISTS idx_categories_sort    ON categories (sort_order, id);
      `);
    },
  },
  {
    version: 2,
    name: 'course-sync',
    up: (db) => {
      db.exec(`
        -- 通用键值设置表：课程同步的节次时间、学期区间、自动同步开关都存在这里
        CREATE TABLE IF NOT EXISTS app_settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- 第三方系统凭据。secret 是本机密文盒加密后的密文，明文密码永不落库。
        CREATE TABLE IF NOT EXISTS sync_credentials (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          source     TEXT NOT NULL,
          username   TEXT NOT NULL,
          secret     TEXT NOT NULL,
          remember   INTEGER NOT NULL DEFAULT 0 CHECK (remember IN (0,1)),
          updated_at TEXT NOT NULL
        );

        -- 外部课表条目 ↔ 本地日程的映射，保证重复导入是幂等的
        CREATE TABLE IF NOT EXISTS course_slot_links (
          source       TEXT    NOT NULL,
          external_key TEXT    NOT NULL,
          event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          title        TEXT    NOT NULL DEFAULT '',
          updated_at   TEXT    NOT NULL,
          PRIMARY KEY (source, external_key)
        );

        -- 每次同步的结果，用于界面展示与排查
        CREATE TABLE IF NOT EXISTS sync_runs (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          source        TEXT    NOT NULL,
          started_at    TEXT    NOT NULL,
          finished_at   TEXT,
          status        TEXT    NOT NULL CHECK (status IN ('running','success','failed')),
          message       TEXT    NOT NULL DEFAULT '',
          created_count INTEGER NOT NULL DEFAULT 0,
          updated_count INTEGER NOT NULL DEFAULT 0,
          removed_count INTEGER NOT NULL DEFAULT 0,
          total_count   INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_sync_runs_source ON sync_runs (source, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_slot_links_event ON course_slot_links (event_id);
      `);
    },
  },
  {
    version: 3,
    name: 'desk-screen-modules',
    up: (db) => {
      db.exec(`
        -- 待办：与日程相互独立，due_date 只存日期串（无时区语义）
        CREATE TABLE IF NOT EXISTS todos (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          title        TEXT    NOT NULL,
          notes        TEXT    NOT NULL DEFAULT '',
          done         INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
          priority     TEXT    NOT NULL DEFAULT 'normal'
                         CHECK (priority IN ('low','normal','high','urgent')),
          due_date     TEXT,
          category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          sort_order   INTEGER NOT NULL DEFAULT 0,
          completed_at TEXT,
          created_at   TEXT    NOT NULL,
          updated_at   TEXT    NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_todos_done    ON todos (done);
        CREATE INDEX IF NOT EXISTS idx_todos_sort    ON todos (sort_order);
        CREATE INDEX IF NOT EXISTS idx_todos_created ON todos (created_at DESC);

        -- 天气缓存：单行表，payload 是完整 WeatherSnapshot 的 JSON
        CREATE TABLE IF NOT EXISTS weather_cache (
          id         INTEGER PRIMARY KEY CHECK (id = 1),
          payload    TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );

        -- 设备最近一次上报的遥测，同样单行；是否配对以 last_seen_at 是否为空判断
        CREATE TABLE IF NOT EXISTS device_status (
          id              INTEGER PRIMARY KEY CHECK (id = 1),
          last_seen_at    TEXT,
          temperature     REAL,
          humidity        REAL,
          battery_voltage REAL,
          battery_percent INTEGER CHECK (battery_percent IS NULL OR (battery_percent BETWEEN 0 AND 100)),
          rssi            INTEGER CHECK (rssi IS NULL OR (rssi BETWEEN -120 AND 0)),
          firmware        TEXT,
          uptime_seconds  INTEGER,
          updated_at      TEXT NOT NULL
        );
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);

function currentVersion(db: SqliteDatabase): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** 依次执行尚未应用的迁移。 */
export function runMigrations(db: SqliteDatabase): { from: number; to: number } {
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter((migration) => migration.version > from).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    logger.info('应用数据库迁移', { version: migration.version, name: migration.name });
    db.exec('BEGIN');
    try {
      migration.up(db);
      // PRAGMA 不接受参数绑定，这里的值来自代码内常量，不存在注入风险
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      logger.error('迁移执行失败', error, { version: migration.version, name: migration.name });
      throw error;
    }
  }

  const to = currentVersion(db);
  if (pending.length === 0) {
    logger.debug('数据库结构已是最新', { version: to });
  } else {
    logger.info('数据库迁移完成', { from, to, applied: pending.length });
  }
  return { from, to };
}

export function describeMigrations(): { version: number; name: string }[] {
  return MIGRATIONS.map((migration) => ({ version: migration.version, name: migration.name }));
}

export function schemaVersion(db: SqliteDatabase): number {
  return currentVersion(db);
}

export function isDatabaseEmpty(db: SqliteDatabase): boolean {
  const row = db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number };
  return Number(row.count) === 0;
}

export function databaseFilePath(): string {
  return config.databaseFile;
}
