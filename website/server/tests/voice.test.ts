/**
 * 语音助手设置接口测试。
 *
 * 覆盖：默认值、局部更新与持久化、唤醒词 trim/去重与中文限制、
 * strict schema 的 422 校验、用户隔离，以及设备载荷 voice 与 ETag。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import {
  closeDatabase,
  getDatabase,
  openDatabase,
  setDatabaseForTesting,
} from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { createTestDevice, createTestUser, loginTestUser, setupTestAdmin } from './helpers/auth.js';

const TOKEN_HEADER = 'X-Device-Token';

const DEFAULTS = {
  enabled: true,
  allowControl: true,
  otaUrl: 'https://api.tenclass.net/xiaozhi/ota/',
  wakeWords: ['你好小智'],
  wakeThreshold: 65,
  volume: 60,
};

let app: Express;
let admin: Awaited<ReturnType<typeof setupTestAdmin>>;

beforeEach(async () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  runMigrations(db);
  setDatabaseForTesting(db);
  app = createApp();
  admin = await setupTestAdmin(app);
});

afterAll(() => {
  closeDatabase();
  setDatabaseForTesting(null);
});

describe('GET /api/voice', () => {
  it('未设置时返回默认值', async () => {
    const response = await admin.get('/api/voice');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(DEFAULTS);
  });

  it('未登录返回 401', async () => {
    const response = await request(app).get('/api/voice');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('PUT /api/voice', () => {
  it('局部更新后持久化，未传字段保持原值', async () => {
    const updated = await admin
      .put('/api/voice')
      .send({ volume: 30, wakeWords: ['小墨', '你好小智'] });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toEqual({
      ...DEFAULTS,
      volume: 30,
      wakeWords: ['小墨', '你好小智'],
    });

    const readBack = await admin.get('/api/voice');
    expect(readBack.body.data).toEqual(updated.body.data);

    const device = await createTestDevice(admin);
    const screen = await request(app).get('/api/device/screen').set(TOKEN_HEADER, device.token);
    expect(screen.status).toBe(200);
    expect(screen.body.data.voice).toEqual(updated.body.data);

    // 唤醒词按 JSON 数组存进 app_settings
    const row = getDatabase()
      .prepare("SELECT value FROM app_settings WHERE key = 'voice.wakeWords'")
      .get() as { value: string };
    expect(JSON.parse(row.value)).toEqual(['小墨', '你好小智']);
  });

  it('布尔与数值字段可单独更新', async () => {
    await admin.put('/api/voice').send({ enabled: false });
    expect((await admin.get('/api/voice')).body.data).toMatchObject({ enabled: false });

    await admin.put('/api/voice').send({ allowControl: false, wakeThreshold: 42 });
    const data = (await admin.get('/api/voice')).body.data;
    expect(data).toMatchObject({ enabled: false, allowControl: false, wakeThreshold: 42 });

    const ota = await admin.put('/api/voice').send({ otaUrl: 'https://example.com/ota/device' });
    expect(ota.body.data.otaUrl).toBe('https://example.com/ota/device');
  });

  it('唤醒词逐条 trim 并去重', async () => {
    const response = await admin
      .put('/api/voice')
      .send({ wakeWords: [' 你好小智 ', '你好小智', ' 小墨'] });
    expect(response.status).toBe(200);
    expect(response.body.data.wakeWords).toEqual(['你好小智', '小墨']);
  });

  it('校验失败返回 422 且不写库', async () => {
    const invalidBodies: Record<string, unknown>[] = [
      { wakeWords: [] },
      { wakeWords: Array.from({ length: 9 }, () => '唤醒词') },
      { wakeWords: ['你好', 'hello'] },
      { wakeWords: ['你'] },
      { wakeWords: ['这是一个非常非常非常长的唤醒词'] },
      { otaUrl: 'ftp://example.com/ota/' },
      { otaUrl: `https://example.com/${'x'.repeat(200)}` },
      { wakeThreshold: 101 },
      { wakeThreshold: -1 },
      { wakeThreshold: 65.5 },
      { volume: 100.5 },
      { enabled: 'yes' },
      { unknownField: true },
    ];

    for (const body of invalidBodies) {
      const response = await admin.put('/api/voice').send(body);
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(response.body.error.details)).toBe(true);
    }

    expect((await admin.get('/api/voice')).body.data).toEqual(DEFAULTS);
  });

  it('错误消息为中文', async () => {
    const badWord = await admin.put('/api/voice').send({ wakeWords: ['abc'] });
    expect(badWord.status).toBe(422);
    expect(badWord.body.error.details[0].message).toContain('汉字');

    const tooMany = await admin
      .put('/api/voice')
      .send({
        wakeWords: ['你好', '小智', '小墨', '阿丽', '小明', '小红', '小白', '小黑', '小蓝'],
      });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.details[0].message).toContain('8');

    const badUrl = await admin.put('/api/voice').send({ otaUrl: 'not-a-url' });
    expect(badUrl.status).toBe(422);
    expect(badUrl.body.error.details[0].message).toContain('http');
  });
});

describe('用户隔离', () => {
  it('每个用户的语音设置互不影响，设备载荷按所属用户下发', async () => {
    await createTestUser(admin, 'alice');
    const alice = await loginTestUser(app, 'alice', 'user-password-123');
    const aliceDevice = await createTestDevice(alice, 'Alice 屏');
    const adminDevice = await createTestDevice(admin, '管理员屏');

    await admin.put('/api/voice').send({ volume: 20, enabled: false });

    expect((await alice.get('/api/voice')).body.data).toEqual(DEFAULTS);

    const aliceScreen = await request(app)
      .get('/api/device/screen')
      .set(TOKEN_HEADER, aliceDevice.token);
    expect(aliceScreen.body.data.voice).toEqual(DEFAULTS);

    const adminScreen = await request(app)
      .get('/api/device/screen')
      .set(TOKEN_HEADER, adminDevice.token);
    expect(adminScreen.body.data.voice).toEqual({ ...DEFAULTS, volume: 20, enabled: false });

    await alice.put('/api/voice').send({ wakeWords: ['阿丽斯'] });
    expect((await alice.get('/api/voice')).body.data.wakeWords).toEqual(['阿丽斯']);
    expect((await admin.get('/api/voice')).body.data.wakeWords).toEqual(['你好小智']);
  });
});

describe('设备载荷与 ETag', () => {
  it('voice 变化会改变 ETag，schemaVersion 仍为 1', async () => {
    const device = await createTestDevice(admin);
    const header = { [TOKEN_HEADER]: device.token };

    const first = await request(app).get('/api/device/screen').set(header);
    expect(first.status).toBe(200);
    expect(first.body.data.schemaVersion).toBe(1);
    expect(first.body.data.voice).toEqual(DEFAULTS);
    const etag = first.headers.etag as string;

    await admin.put('/api/voice').send({ wakeWords: ['小墨'] });

    const changed = await request(app)
      .get('/api/device/screen')
      .set(header)
      .set('If-None-Match', etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
    expect(changed.body.data.voice.wakeWords).toEqual(['小墨']);

    const cached = await request(app)
      .get('/api/device/screen')
      .set(header)
      .set('If-None-Match', changed.headers.etag as string);
    expect(cached.status).toBe(304);
  });

  it('改语音设置不影响布局、刷新间隔与其他屏幕数据', async () => {
    const device = await createTestDevice(admin);
    const header = { [TOKEN_HEADER]: device.token };

    const before = await request(app).get('/api/device/screen').set(header);
    await admin.put('/api/voice').send({ volume: 5, enabled: false });
    const after = await request(app).get('/api/device/screen').set(header);

    expect(after.body.data.timezone).toBe(before.body.data.timezone);
    expect(after.body.data.screen).toEqual(before.body.data.screen);
    expect(after.body.data.now.date).toBe(before.body.data.now.date);
    expect(after.body.data.events).toEqual(before.body.data.events);
    expect(after.body.data.voice).toEqual({ ...DEFAULTS, volume: 5, enabled: false });
  });
});
