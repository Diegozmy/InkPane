/** v4 → v5 迁移：把已保存的课程系统地址从 http 升级到 https。 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { LATEST_SCHEMA_VERSION, runMigrations, schemaVersion } from '../src/db/migrations.js';

let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  closeDatabase();
  db = openDatabase(':memory:');
  setDatabaseForTesting(db);
  runMigrations(db, { to: 4 });

  const timestamp = new Date().toISOString();
  // v4 迁移会预置一个管理员账号，直接复用它的 id
  const user = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number };
  const userId = user.id;
  db.prepare(
    `INSERT INTO sync_credentials (user_id, source, username, secret, base_url, remember, updated_at)
     VALUES (?, 'yucai-ws8', 'student01', 'cipher', 'http://ws8.yucai.sh.cn', 1, ?)`,
  ).run(userId, timestamp);
  db.prepare(
    `INSERT INTO app_settings (user_id, key, value, updated_at)
     VALUES (?, 'course-sync', ?, ?)`,
  ).run(userId, JSON.stringify({ baseUrl: 'http://ws8.yucai.sh.cn', totalWeeks: 18 }), timestamp);
});

afterAll(() => {
  closeDatabase();
  setDatabaseForTesting(null);
});

describe('v5 迁移', () => {
  it('把凭据与设置里的 http 地址升级为 https，并保留其他字段', () => {
    runMigrations(db);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);

    const credential = db
      .prepare('SELECT base_url FROM sync_credentials WHERE user_id = 1')
      .get() as { base_url: string };
    expect(credential.base_url).toBe('https://ws8.yucai.sh.cn');

    const setting = db
      .prepare("SELECT value FROM app_settings WHERE user_id = 1 AND key = 'course-sync'")
      .get() as { value: string };
    expect(JSON.parse(setting.value)).toMatchObject({
      baseUrl: 'https://ws8.yucai.sh.cn',
      totalWeeks: 18,
    });
  });
});
