/**
 * 版本化数据库迁移。
 * 使用 SQLite 内置的 PRAGMA user_version 记录当前结构版本，幂等且可重复执行。
 */

import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import type { SqliteDatabase } from './client.js';

interface Migration {
  version: number;
  name: string;
  /** 重建表期间需要临时关闭外键；迁移提交前会执行 foreign_key_check */
  disableForeignKeys?: boolean;
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
  {
    version: 4,
    name: 'multi-user-and-devices',
    disableForeignKeys: true,
    up: (db) => {
      const timestamp = new Date().toISOString();

      db.exec(`
        CREATE TABLE users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT    NOT NULL COLLATE NOCASE UNIQUE,
          display_name  TEXT    NOT NULL DEFAULT '',
          password_hash TEXT,
          role          TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
          status        TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('pending_setup','active','disabled')),
          created_at    TEXT    NOT NULL,
          updated_at    TEXT    NOT NULL,
          last_login_at TEXT
        );

        CREATE TABLE sessions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash   TEXT    NOT NULL UNIQUE,
          created_at   TEXT    NOT NULL,
          last_used_at TEXT    NOT NULL,
          expires_at   TEXT    NOT NULL,
          revoked_at   TEXT,
          user_agent   TEXT
        );
        CREATE INDEX idx_sessions_user ON sessions (user_id);
        CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

        CREATE TABLE devices (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name            TEXT    NOT NULL,
          token_hash      TEXT    NOT NULL UNIQUE,
          token_prefix    TEXT    NOT NULL,
          created_at      TEXT    NOT NULL,
          updated_at      TEXT    NOT NULL,
          last_seen_at    TEXT,
          firmware        TEXT,
          battery_voltage REAL,
          battery_percent INTEGER CHECK (battery_percent IS NULL OR (battery_percent BETWEEN 0 AND 100)),
          rssi            INTEGER CHECK (rssi IS NULL OR (rssi BETWEEN -120 AND 0)),
          temperature     REAL,
          humidity        REAL,
          uptime_seconds  INTEGER,
          revoked_at      TEXT
        );
        CREATE INDEX idx_devices_user ON devices (user_id);
      `);

      // 旧库里没有用户；先创建一个待初始化的 owner，由 /api/setup 认领。
      db.prepare(
        `INSERT INTO users (username, display_name, password_hash, role, status, created_at, updated_at)
         SELECT 'owner', 'InkPane', NULL, 'admin', 'pending_setup', ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM users)`,
      ).run(timestamp, timestamp);

      db.exec(`
        CREATE TABLE categories_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name       TEXT    NOT NULL,
          color      TEXT    NOT NULL,
          icon       TEXT,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT    NOT NULL,
          updated_at TEXT    NOT NULL,
          UNIQUE (user_id, name)
        );
        INSERT INTO categories_new (id, user_id, name, color, icon, sort_order, created_at, updated_at)
        SELECT id, 1, name, color, icon, sort_order, created_at, updated_at FROM categories;

        CREATE TABLE events_new (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title                 TEXT    NOT NULL,
          description           TEXT    NOT NULL DEFAULT '',
          location              TEXT    NOT NULL DEFAULT '',
          category_id           INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          priority              TEXT    NOT NULL DEFAULT 'normal'
                                  CHECK (priority IN ('low','normal','high','urgent')),
          status                TEXT    NOT NULL DEFAULT 'confirmed'
                                  CHECK (status IN ('confirmed','tentative','cancelled')),
          all_day               INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
          start_at              TEXT    NOT NULL,
          end_at                TEXT    NOT NULL,
          timezone              TEXT    NOT NULL DEFAULT 'UTC',
          tags                  TEXT    NOT NULL DEFAULT '[]',
          rrule                 TEXT,
          color                 TEXT,
          remind_minutes_before INTEGER,
          created_at            TEXT    NOT NULL,
          updated_at            TEXT    NOT NULL
        );
        INSERT INTO events_new
          (id, user_id, title, description, location, category_id, priority, status, all_day,
           start_at, end_at, timezone, tags, rrule, color, remind_minutes_before, created_at, updated_at)
        SELECT id, 1, title, description, location, category_id, priority, status, all_day,
               start_at, end_at, timezone, tags, rrule, color, remind_minutes_before, created_at, updated_at
        FROM events;

        CREATE TABLE todos_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
        INSERT INTO todos_new
          (id, user_id, title, notes, done, priority, due_date, category_id, sort_order,
           completed_at, created_at, updated_at)
        SELECT id, 1, title, notes, done, priority, due_date, category_id, sort_order,
               completed_at, created_at, updated_at
        FROM todos;

        CREATE TABLE app_settings_new (
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          key        TEXT    NOT NULL,
          value      TEXT    NOT NULL,
          updated_at TEXT    NOT NULL,
          PRIMARY KEY (user_id, key)
        );
        INSERT INTO app_settings_new (user_id, key, value, updated_at)
        SELECT 1, key, value, updated_at FROM app_settings WHERE key NOT LIKE 'device.%';

        CREATE TABLE weather_cache_new (
          user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          payload    TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );
        INSERT INTO weather_cache_new (user_id, payload, fetched_at)
        SELECT 1, payload, fetched_at FROM weather_cache WHERE id = 1;

        CREATE TABLE sync_credentials_new (
          user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          source     TEXT    NOT NULL,
          username   TEXT    NOT NULL,
          secret     TEXT    NOT NULL,
          base_url   TEXT    NOT NULL DEFAULT '',
          remember   INTEGER NOT NULL DEFAULT 0 CHECK (remember IN (0,1)),
          updated_at TEXT    NOT NULL
        );

        CREATE TABLE course_slot_links_new (
          user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          source       TEXT    NOT NULL,
          external_key TEXT    NOT NULL,
          event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
          title        TEXT    NOT NULL DEFAULT '',
          updated_at   TEXT    NOT NULL,
          PRIMARY KEY (user_id, source, external_key)
        );
        INSERT INTO course_slot_links_new (user_id, source, external_key, event_id, title, updated_at)
        SELECT 1, source, external_key, event_id, title, updated_at FROM course_slot_links;

        CREATE TABLE sync_runs_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
        INSERT INTO sync_runs_new
          (id, user_id, source, started_at, finished_at, status, message,
           created_count, updated_count, removed_count, total_count)
        SELECT id, 1, source, started_at, finished_at, status, message,
               created_count, updated_count, removed_count, total_count
        FROM sync_runs;
      `);

      // 旧课程设置里的 baseUrl 尽量沿用到凭据上；解析失败时使用默认地址。
      let courseBaseUrl = 'http://ws8.yucai.sh.cn';
      try {
        const row = db
          .prepare("SELECT value FROM app_settings WHERE key = 'course-sync'")
          .get() as { value?: string } | undefined;
        if (row?.value) {
          const parsed = JSON.parse(row.value) as { baseUrl?: unknown };
          if (typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim().length > 0) {
            courseBaseUrl = parsed.baseUrl.trim();
          }
        }
      } catch {
        // 旧设置损坏时保持默认值
      }
      db.prepare(
        `INSERT INTO sync_credentials_new (user_id, source, username, secret, base_url, remember, updated_at)
         SELECT 1, source, username, secret, ?, remember, updated_at FROM sync_credentials WHERE id = 1`,
      ).run(courseBaseUrl);

      // 旧单例设备令牌：哈希后迁入 devices，旧固件无需改配置即可继续拉取。
      const legacyToken = db
        .prepare("SELECT value FROM app_settings WHERE key = 'device.token'")
        .get() as { value?: string } | undefined;
      const legacyName = db
        .prepare("SELECT value FROM app_settings WHERE key = 'device.name'")
        .get() as { value?: string } | undefined;
      const status = db
        .prepare('SELECT * FROM device_status WHERE id = 1')
        .get() as Record<string, unknown> | undefined;

      const token = legacyToken?.value?.trim().toLowerCase() ?? '';
      if (/^[0-9a-f]{32}$/.test(token)) {
        const hash = createHash('sha256').update(token).digest('hex');
        db.prepare(
          `INSERT INTO devices
             (user_id, name, token_hash, token_prefix, created_at, updated_at, last_seen_at,
              firmware, battery_voltage, battery_percent, rssi, temperature, humidity, uptime_seconds)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          legacyName?.value?.trim() || 'InkPane 墨窗',
          hash,
          `${token.slice(0, 4)}...${token.slice(-4)}`,
          (status?.updated_at as string | undefined) ?? timestamp,
          (status?.updated_at as string | undefined) ?? timestamp,
          (status?.last_seen_at as string | null | undefined) ?? null,
          (status?.firmware as string | null | undefined) ?? null,
          (status?.battery_voltage as number | null | undefined) ?? null,
          (status?.battery_percent as number | null | undefined) ?? null,
          (status?.rssi as number | null | undefined) ?? null,
          (status?.temperature as number | null | undefined) ?? null,
          (status?.humidity as number | null | undefined) ?? null,
          (status?.uptime_seconds as number | null | undefined) ?? null,
        );
      }

      db.exec(`
        DROP TABLE device_status;
        DROP TABLE course_slot_links;
        DROP TABLE sync_runs;
        DROP TABLE sync_credentials;
        DROP TABLE weather_cache;
        DROP TABLE todos;
        DROP TABLE events;
        DROP TABLE categories;
        DROP TABLE app_settings;

        ALTER TABLE categories_new RENAME TO categories;
        ALTER TABLE events_new RENAME TO events;
        ALTER TABLE todos_new RENAME TO todos;
        ALTER TABLE app_settings_new RENAME TO app_settings;
        ALTER TABLE weather_cache_new RENAME TO weather_cache;
        ALTER TABLE sync_credentials_new RENAME TO sync_credentials;
        ALTER TABLE course_slot_links_new RENAME TO course_slot_links;
        ALTER TABLE sync_runs_new RENAME TO sync_runs;

        CREATE INDEX idx_categories_user_sort ON categories (user_id, sort_order, id);
        CREATE INDEX idx_events_user_start    ON events (user_id, start_at);
        CREATE INDEX idx_events_user_category ON events (user_id, category_id);
        CREATE INDEX idx_events_user_status   ON events (user_id, status);
        CREATE INDEX idx_todos_user_done      ON todos (user_id, done);
        CREATE INDEX idx_todos_user_sort      ON todos (user_id, sort_order);
        CREATE INDEX idx_todos_user_created   ON todos (user_id, created_at DESC);
        CREATE INDEX idx_slot_links_event     ON course_slot_links (event_id);
        CREATE INDEX idx_sync_runs_user       ON sync_runs (user_id, source, started_at DESC);
      `);

      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new Error(`迁移后外键校验失败：${JSON.stringify(violations.slice(0, 3))}`);
      }
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

export interface RunMigrationsOptions {
  /** 仅测试/诊断用：迁移到指定版本（不执行更高版本）。 */
  to?: number;
}

/** 依次执行尚未应用的迁移。 */
export function runMigrations(
  db: SqliteDatabase,
  options: RunMigrationsOptions = {},
): { from: number; to: number } {
  const from = currentVersion(db);
  const target = options.to ?? LATEST_SCHEMA_VERSION;
  const pending = MIGRATIONS.filter(
    (migration) => migration.version > from && migration.version <= target,
  ).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    logger.info('应用数据库迁移', { version: migration.version, name: migration.name });
    if (migration.disableForeignKeys) {
      // PRAGMA foreign_keys 不能在事务内切换；重建表前必须先关掉。
      db.exec('PRAGMA foreign_keys = OFF');
    }
    db.exec('BEGIN');
    try {
      migration.up(db);
      // PRAGMA 不接受参数绑定，这里的值来自代码内常量，不存在注入风险
      db.exec(`PRAGMA user_version = ${migration.version}`);
      if (migration.disableForeignKeys) {
        const violations = db.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(`外键校验失败：${JSON.stringify(violations.slice(0, 3))}`);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        logger.error('迁移回滚失败', rollbackError);
      }
      logger.error('迁移执行失败', error, { version: migration.version, name: migration.name });
      throw error;
    } finally {
      if (migration.disableForeignKeys) {
        db.exec('PRAGMA foreign_keys = ON');
      }
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
