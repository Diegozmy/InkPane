/**
 * 设备接口测试。
 *
 * 覆盖：设备令牌一次性下发、轮换/撤销、401 鉴权、ETag/304、
 * 屏幕载荷字段、遥测按设备隔离与字段校验。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { closeDatabase, getDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { todayDateKey } from '../src/domain/display-time.js';
import { createTestDevice, setupTestAdmin } from './helpers/auth.js';

const TZ = 'Asia/Shanghai';
const TOKEN_HEADER = 'X-Device-Token';

let app: Express;
let agent: Awaited<ReturnType<typeof setupTestAdmin>>;

function today(): string {
  return todayDateKey(TZ);
}

async function getScreen(token: string, headers: Record<string, string> = {}) {
  let call = request(app).get('/api/device/screen').set(TOKEN_HEADER, token);
  for (const [key, value] of Object.entries(headers)) call = call.set(key, value);
  return call;
}

async function createTodayEvent(body: Record<string, unknown>): Promise<number> {
  const response = await agent
    .post('/api/events')
    .send({
      title: '默认日程',
      allDay: true,
      startAt: today(),
      endAt: today(),
      timezone: TZ,
      ...body,
    });
  expect(response.status).toBe(201);
  return response.body.data.id as number;
}

beforeEach(async () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  runMigrations(db);
  setDatabaseForTesting(db);
  app = createApp();
  agent = await setupTestAdmin(app);
});

afterAll(() => {
  closeDatabase();
  setDatabaseForTesting(null);
});

describe('设备令牌', () => {
  it('创建设备时只返回一次 32 位 hex 令牌，列表不泄露完整令牌', async () => {
    const created = await createTestDevice(agent);
    expect(created.token).toMatch(/^[0-9a-f]{32}$/);

    const list = await agent.get('/api/devices');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].tokenPrefix).toBe(
      `${created.token.slice(0, 4)}...${created.token.slice(-4)}`,
    );
    expect(JSON.stringify(list.body.data)).not.toContain(created.token);
  });

  it('轮换后旧令牌立即失效，新令牌可用；撤销后全部失效', async () => {
    const created = await createTestDevice(agent);
    expect((await getScreen(created.token)).status).toBe(200);

    const rotated = await agent.post(`/api/devices/${created.id}/rotate`);
    expect(rotated.status).toBe(200);
    const newToken = rotated.body.data.token as string;
    expect(newToken).toMatch(/^[0-9a-f]{32}$/);
    expect(newToken).not.toBe(created.token);
    expect((await getScreen(created.token)).status).toBe(401);
    expect((await getScreen(newToken)).status).toBe(200);

    expect((await agent.delete(`/api/devices/${created.id}`)).status).toBe(200);
    expect((await getScreen(newToken)).status).toBe(401);
  });
});

describe('设备鉴权', () => {
  it('缺失、错误或放在 query 里的令牌都返回 401', async () => {
    const created = await createTestDevice(agent);

    expect((await request(app).get('/api/device/screen')).status).toBe(401);
    expect((await getScreen('f'.repeat(32))).status).toBe(401);
    expect(
      (await request(app).get('/api/device/screen').query({ token: created.token })).status,
    ).toBe(401);
  });

  it('遥测接口同样需要令牌', async () => {
    const response = await request(app).post('/api/device/telemetry').send({ temperature: 20 });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('屏幕载荷与 ETag', () => {
  it('200 响应带 ETag 与 no-cache，If-None-Match 命中返回 304', async () => {
    const created = await createTestDevice(agent);

    const first = await getScreen(created.token);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(first.headers['cache-control']).toBe('no-cache');
    expect(first.body.data.schemaVersion).toBe(1);
    expect(first.body.data.device).toMatchObject({ id: created.id, name: '测试设备' });

    const cached = await getScreen(created.token, { 'If-None-Match': etag });
    expect(cached.status).toBe(304);
    expect(cached.text).toBe('');
    expect(cached.headers.etag).toBe(etag);

    await agent.post('/api/todos').send({ title: '新待办' });
    const changed = await getScreen(created.token, { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('载荷包含今日日程、课程、待办与月历标记', async () => {
    const created = await createTestDevice(agent);
    const day = today();
    const dayNumber = Number(day.slice(8, 10));

    const category = await agent
      .post('/api/categories')
      .send({ name: '工作', color: '#3b6fd4' });
    const eventId = await createTodayEvent({
      title: '今日评审',
      location: '三号会议室',
      categoryId: category.body.data.id,
    });

    const courseId = await createTodayEvent({ title: '语文' });
    const userId = Number(
      (getDatabase().prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id,
    );
    getDatabase()
      .prepare(
        `INSERT INTO course_slot_links (user_id, source, external_key, event_id, title, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, 'test-source', 'test-source:1:1', courseId, '语文', new Date().toISOString());

    const todo = await agent.post('/api/todos').send({ title: '买牛奶', priority: 'high' });

    const response = await getScreen(created.token);
    expect(response.status).toBe(200);
    const payload = response.body.data;

    expect(payload.timezone).toBe(TZ);
    expect(payload.screen).toMatchObject({ width: 800, height: 480, refreshMinutes: 30 });
    expect(payload.screen.layout.modules).toHaveLength(6);
    expect(payload.now.date).toBe(day);
    expect(payload.now.weekday).toMatch(/^周[一二三四五六日]$/);
    expect(payload.now.time).toMatch(/^\d{2}:\d{2}$/);
    expect(payload.now.epochSeconds).toBeGreaterThan(0);
    expect(payload.now.utcOffsetMinutes).toBe(480);
    expect(payload.now.localIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    expect(payload.month).toMatchObject({
      year: Number(day.slice(0, 4)),
      month: Number(day.slice(5, 7)),
      today: dayNumber,
    });
    expect(payload.month.marks).toContain(dayNumber);

    const event = payload.events.find((item: { title: string }) => item.title === '今日评审');
    expect(event).toMatchObject({
      eventId,
      title: '今日评审',
      location: '三号会议室',
      allDay: true,
      categoryId: category.body.data.id,
      color: '#3b6fd4',
      priority: 'normal',
      isCourse: false,
    });

    const course = payload.courses.find((item: { title: string }) => item.title === '语文');
    expect(course).toMatchObject({ eventId: courseId, isCourse: true });
    expect(payload.events.map((item: { title: string }) => item.title)).not.toContain('语文');

    expect(payload.todos).toEqual([
      { id: todo.body.data.id, title: '买牛奶', priority: 'high', dueDate: null },
    ]);
    expect(payload.weather).toBeNull();
  });

  it('未完成待办最多返回 8 条', async () => {
    const created = await createTestDevice(agent);
    for (let index = 0; index < 10; index += 1) {
      await agent.post('/api/todos').send({ title: `待办 ${index}` });
    }
    const finished = await agent.post('/api/todos').send({ title: '已完成的' });
    await agent.patch(`/api/todos/${finished.body.data.id}`).send({ done: true });

    const response = await getScreen(created.token);
    expect(response.body.data.todos).toHaveLength(8);
  });
});

describe('遥测与设备状态', () => {
  it('上报遥测后设备状态更新，并保留各字段', async () => {
    const created = await createTestDevice(agent);
    const before = await agent.get('/api/devices');
    expect(before.body.data[0]).toMatchObject({
      id: created.id,
      name: '测试设备',
      online: false,
      lastSeenAt: null,
      firmware: null,
      batteryPercent: null,
    });

    const telemetry = await request(app)
      .post('/api/device/telemetry')
      .set(TOKEN_HEADER, created.token)
      .send({
        temperature: 24.5,
        humidity: 55,
        batteryVoltage: 3.9,
        batteryPercent: 88,
        rssi: -55,
        firmware: '1.0.0',
        uptimeSeconds: 3600,
      });
    expect(telemetry.status).toBe(200);
    const receivedAt = telemetry.body.data.receivedAt as string;

    const after = await agent.get('/api/devices');
    expect(after.body.data[0]).toMatchObject({
      online: true,
      lastSeenAt: receivedAt,
      firmware: '1.0.0',
      batteryPercent: 88,
      batteryVoltage: 3.9,
      rssi: -55,
      indoorTemperature: 24.5,
      indoorHumidity: 55,
    });

    await request(app)
      .post('/api/device/telemetry')
      .set(TOKEN_HEADER, created.token)
      .send({ temperature: 26 });
    const partial = await agent.get('/api/devices');
    expect(partial.body.data[0]).toMatchObject({
      indoorTemperature: 26,
      batteryPercent: 88,
      firmware: '1.0.0',
    });
  });

  it('遥测字段越界或多余字段返回 422', async () => {
    const created = await createTestDevice(agent);
    const cases: Record<string, unknown>[] = [
      { batteryPercent: 101 },
      { batteryPercent: -1 },
      { rssi: -121 },
      { rssi: 5 },
      { firmware: 'x'.repeat(65) },
      { uptimeSeconds: -1 },
      { batteryPercent: 50.5 },
      { unknownField: 1 },
    ];
    for (const body of cases) {
      const response = await request(app)
        .post('/api/device/telemetry')
        .set(TOKEN_HEADER, created.token)
        .send(body);
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('设备设置', () => {
  it('可以修改名称与刷新间隔', async () => {
    const created = await createTestDevice(agent);
    const renamed = await agent.patch(`/api/devices/${created.id}`).send({ name: '书房屏' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ id: created.id, name: '书房屏' });

    const display = await agent.put('/api/display').send({ refreshMinutes: 60 });
    expect(display.status).toBe(200);
    expect(display.body.data.refreshMinutes).toBe(60);

    const list = await agent.get('/api/devices');
    expect(list.body.data[0].name).toBe('书房屏');
  });

  it('名称过长、刷新间隔越界返回 422/400', async () => {
    const created = await createTestDevice(agent);
    expect((await agent.patch(`/api/devices/${created.id}`).send({ name: 'x'.repeat(41) })).status).toBe(422);
    expect((await agent.put('/api/display').send({ refreshMinutes: 4 })).status).toBe(400);
    expect((await agent.put('/api/display').send({ refreshMinutes: 721 })).status).toBe(400);
  });
});
