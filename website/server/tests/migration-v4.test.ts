/** v3 → v4 迁移：旧数据归属、设备令牌保留与结构校验。 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { closeDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { runMigrations, schemaVersion } from '../src/db/migrations.js';

const OLD_TOKEN = '7f3a9c2e5b8d4a61c0f9e2d7b4a8c153';
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  closeDatabase();
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  runMigrations(db, { to: 3 });

  const timestamp = new Date().toISOString();
  db.prepare(
    `INSERT INTO categories (name, color, icon, sort_order, created_at, updated_at)
     VALUES ('工作', '#3b6fd4', NULL, 10, ?, ?)`,
  ).run(timestamp, timestamp);
  db.prepare(
    `INSERT INTO events
      (title, description, location, category_id, priority, status, all_day, start_at, end_at,
       timezone, tags, rrule, color, remind_minutes_before, created_at, updated_at)
     VALUES ('旧日程', '', '', 1, 'normal', 'confirmed', 0, ?, ?, 'Asia/Shanghai', '[]', NULL, NULL, NULL, ?, ?)`,
  ).run(timestamp, timestamp, timestamp, timestamp);
  db.prepare(
    `INSERT INTO todos (title, notes, done, priority, due_date, category_id, sort_order,
       completed_at, created_at, updated_at)
     VALUES ('旧待办', '', 0, 'normal', NULL, 1, 10, NULL, ?, ?)`,
  ).run(timestamp, timestamp);
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('display.timezone', 'Asia/Shanghai', ?)`,
  ).run(timestamp);
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('device.token', ?, ?)`,
  ).run(OLD_TOKEN, timestamp);
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('device.name', '旧设备', ?)`,
  ).run(timestamp);
  db.prepare(
    `INSERT INTO device_status
      (id, last_seen_at, temperature, humidity, battery_voltage, battery_percent, rssi,
       firmware, uptime_seconds, updated_at)
     VALUES (1, ?, 24.5, 55, 3.9, 88, -55, '1.0.0', 100, ?)`,
  ).run(timestamp, timestamp);
});

afterAll(() => {
  closeDatabase();
  setDatabaseForTesting(null);
});

describe('v4 迁移', () => {
  it('把旧数据归到第一个管理员，并保留旧设备令牌', () => {
    runMigrations(db);
    expect(schemaVersion(db)).toBe(4);

    const owner = db.prepare('SELECT id, role, status FROM users').get() as {
      id: number;
      role: string;
      status: string;
    };
    expect(owner).toMatchObject({ id: 1, role: 'admin', status: 'pending_setup' });

    const event = db.prepare('SELECT user_id, title FROM events').get() as {
      user_id: number;
      title: string;
    };
    expect(event).toMatchObject({ user_id: 1, title: '旧日程' });

    const todo = db.prepare('SELECT user_id, title FROM todos').get() as {
      user_id: number;
      title: string;
    };
    expect(todo).toMatchObject({ user_id: 1, title: '旧待办' });

    const setting = db
      .prepare("SELECT user_id FROM app_settings WHERE key = 'display.timezone'")
      .get() as { user_id: number };
    expect(setting.user_id).toBe(1);

    const device = db
      .prepare('SELECT user_id, token_hash, token_prefix, temperature FROM devices')
      .get() as {
      user_id: number;
      token_hash: string;
      token_prefix: string;
      temperature: number;
    };
    expect(device.user_id).toBe(1);
    expect(device.token_hash).toBe(createHash('sha256').update(OLD_TOKEN).digest('hex'));
    expect(device.token_prefix).toBe(`${OLD_TOKEN.slice(0, 4)}...${OLD_TOKEN.slice(-4)}`);
    expect(device.temperature).toBe(24.5);

    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });
});
