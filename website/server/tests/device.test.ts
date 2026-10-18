/**
 * 设备接口测试。
 *
 * 覆盖：令牌生成与轮换、401 鉴权、ETag/304、屏幕载荷字段形状（今日日程/课程/待办）、
 * 遥测校验与状态、设置更新，以及「令牌不能走 query 参数」这一安全约束。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { closeDatabase, getDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { todayDateKey } from '../src/domain/display-time.js';

const TZ = 'Asia/Shanghai';
const TOKEN_HEADER = 'X-Device-Token';

let app: Express;

function today(): string {
  return todayDateKey(TZ);
}

async function fetchToken(): Promise<string> {
  const response = await request(app).get('/api/device/token');
  expect(response.status).toBe(200);
  return response.body.data.token as string;
}

async function getScreen(token: string, headers: Record<string, string> = {}) {
  let call = request(app).get('/api/device/screen').set(TOKEN_HEADER, token);
  for (const [key, value] of Object.entries(headers)) call = call.set(key, value);
  return call;
}

async function createTodayEvent(body: Record<string, unknown>): Promise<number> {
  const response = await request(app)
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

beforeEach(() => {
  closeDatabase();
  const db = openDatabase(':memory:');
  runMigrations(db);
  setDatabaseForTesting(db);
  app = createApp();
});

afterAll(() => {
  closeDatabase();
  setDatabaseForTesting(null);
});

describe('设备令牌', () => {
  it('首次读取自动生成 32 位 hex 并保持稳定', async () => {
    const token = await fetchToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await fetchToken()).toBe(token);
  });

  it('轮换后旧令牌立即失效，新令牌可用', async () => {
    const oldToken = await fetchToken();

    const rotated = await request(app).post('/api/device/token');
    expect(rotated.status).toBe(200);
    const newToken = rotated.body.data.token as string;
    expect(newToken).toMatch(/^[0-9a-f]{32}$/);
    expect(newToken).not.toBe(oldToken);

    expect((await getScreen(oldToken)).status).toBe(401);
    expect((await getScreen(newToken)).status).toBe(200);
    expect(await fetchToken()).toBe(newToken);
  });
});

describe('设备鉴权', () => {
  it('缺失、错误或放在 query 里的令牌都返回 401', async () => {
    const token = await fetchToken();

    const missing = await request(app).get('/api/device/screen');
    expect(missing.status).toBe(401);
    expect(missing.body.error).toMatchObject({ code: 'UNAUTHORIZED', message: '设备令牌无效' });

    const wrong = await getScreen('f'.repeat(32));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('UNAUTHORIZED');

    // 不接受 query 参数传递令牌
    const queryToken = await request(app).get('/api/device/screen').query({ token });
    expect(queryToken.status).toBe(401);

    expect(await fetchToken()).toBe(token);
  });

  it('遥测接口同样需要令牌', async () => {
    const response = await request(app).post('/api/device/telemetry').send({ temperature: 20 });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('屏幕载荷与 ETag', () => {
  it('200 响应带 ETag 与 no-cache，If-None-Match 命中返回 304', async () => {
    const token = await fetchToken();

    const first = await getScreen(token);
    expect(first.status).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(first.headers['cache-control']).toBe('no-cache');

    const cached = await getScreen(token, { 'If-None-Match': etag });
    expect(cached.status).toBe(304);
    expect(cached.text).toBe('');
    expect(cached.headers.etag).toBe(etag);

    // 数据变化后 ETag 必须变化，避免设备端一直拿旧画面
    await request(app).post('/api/todos').send({ title: '新待办' });
    const changed = await getScreen(token, { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('载荷包含今日日程、课程、待办与月历标记', async () => {
    const token = await fetchToken();
    const day = today();
    const dayNumber = Number(day.slice(8, 10));

    const category = await request(app)
      .post('/api/categories')
      .send({ name: '工作', color: '#3b6fd4' });
    const eventId = await createTodayEvent({
      title: '今日评审',
      location: '三号会议室',
      categoryId: category.body.data.id,
    });

    const courseId = await createTodayEvent({ title: '语文' });
    getDatabase()
      .prepare(
        `INSERT INTO course_slot_links (source, external_key, event_id, title, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('test-source', 'test-source:1:1', courseId, '语文', new Date().toISOString());

    const todo = await request(app)
      .post('/api/todos')
      .send({ title: '买牛奶', priority: 'high' });

    const response = await getScreen(token);
    expect(response.status).toBe(200);
    const payload = response.body.data;

    expect(payload.timezone).toBe(TZ);
    expect(payload.screen).toMatchObject({ width: 800, height: 480, refreshMinutes: 30 });
    expect(payload.screen.layout.modules).toHaveLength(6);
    expect(payload.now.date).toBe(day);
    expect(payload.now.weekday).toMatch(/^周[一二三四五六日]$/);
    expect(payload.now.time).toMatch(/^\d{2}:\d{2}$/);
    expect(payload.now.dateLabel).toBe(`${Number(day.slice(5, 7))}月${dayNumber}日`);
    expect(new Date(payload.now.iso as string).toISOString()).toBe(payload.now.iso);
    expect(new Date(payload.generatedAt as string).toISOString()).toBe(payload.generatedAt);

    expect(payload.month).toMatchObject({
      year: Number(day.slice(0, 4)),
      month: Number(day.slice(5, 7)),
      today: dayNumber,
    });
    expect(payload.month.firstWeekday).toBeGreaterThanOrEqual(0);
    expect(payload.month.firstWeekday).toBeLessThanOrEqual(6);
    expect(payload.month.daysInMonth).toBeGreaterThanOrEqual(28);
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
    expect(event.id).toBe(`${event.eventId}:${event.occurrenceKey}`);
    expect(event.startAt).toBe(day);

    const course = payload.courses.find((item: { title: string }) => item.title === '语文');
    expect(course).toMatchObject({ eventId: courseId, isCourse: true });
    expect(payload.events.map((item: { title: string }) => item.title)).not.toContain('语文');
    expect(payload.courses).toHaveLength(1);

    expect(payload.todos).toEqual([
      { id: todo.body.data.id, title: '买牛奶', priority: 'high', dueDate: null },
    ]);
    expect(payload.weather).toBeNull();
  });

  it('未完成待办最多返回 8 条', async () => {
    const token = await fetchToken();
    for (let index = 0; index < 10; index += 1) {
      await request(app).post('/api/todos').send({ title: `待办 ${index}` });
    }
    const finished = await request(app).post('/api/todos').send({ title: '已完成的' });
    expect(finished.status).toBe(201);
    await request(app).patch(`/api/todos/${finished.body.data.id}`).send({ done: true });

    const response = await getScreen(token);
    expect(response.status).toBe(200);
    expect(response.body.data.todos).toHaveLength(8);
    expect(response.body.data.todos.map((item: { title: string }) => item.title)).toEqual([
      '待办 0',
      '待办 1',
      '待办 2',
      '待办 3',
      '待办 4',
      '待办 5',
      '待办 6',
      '待办 7',
    ]);
  });
});

describe('遥测与设备状态', () => {
  it('上报遥测后状态变为已配对，并保留各字段', async () => {
    const token = await fetchToken();

    const before = await request(app).get('/api/device/status');
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({
      paired: false,
      name: 'InkPane 墨窗',
      lastSeenAt: null,
      firmware: null,
      batteryPercent: null,
      batteryVoltage: null,
      rssi: null,
      indoorTemperature: null,
      indoorHumidity: null,
      refreshMinutes: 30,
    });
    expect(before.body.data.tokenPreview).toBe(`${token.slice(0, 4)}...${token.slice(-4)}`);
    expect(before.body.data.screenVersion).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(before.body.data.layoutUpdatedAt as string).toString()).not.toBe('Invalid Date');
    expect(new Date(before.body.data.serverTime as string).toString()).not.toBe('Invalid Date');

    const telemetry = await request(app).post('/api/device/telemetry').set(TOKEN_HEADER, token).send({
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
    expect(new Date(receivedAt).toISOString()).toBe(receivedAt);

    const after = await request(app).get('/api/device/status');
    expect(after.body.data).toMatchObject({
      paired: true,
      lastSeenAt: receivedAt,
      firmware: '1.0.0',
      batteryPercent: 88,
      batteryVoltage: 3.9,
      rssi: -55,
      indoorTemperature: 24.5,
      indoorHumidity: 55,
    });

    // 只上报部分字段时，其余字段保留上次的值
    await request(app)
      .post('/api/device/telemetry')
      .set(TOKEN_HEADER, token)
      .send({ temperature: 26 });
    const partial = await request(app).get('/api/device/status');
    expect(partial.body.data).toMatchObject({
      indoorTemperature: 26,
      batteryPercent: 88,
      firmware: '1.0.0',
    });
  });

  it('遥测字段越界或多余字段返回 422', async () => {
    const token = await fetchToken();

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
        .set(TOKEN_HEADER, token)
        .send(body);
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('status 的 screenVersion 与屏幕 ETag 一致', async () => {
    const token = await fetchToken();
    const screen = await getScreen(token);
    const etag = screen.headers.etag as string;

    const status = await request(app).get('/api/device/status');
    expect(status.body.data.screenVersion).toBe(etag.slice(1, -1));
  });
});

describe('设备设置', () => {
  it('可以修改名称与刷新间隔，并与显示设置共用 refreshMinutes', async () => {
    const response = await request(app)
      .put('/api/device/settings')
      .send({ name: '书房屏', refreshMinutes: 60 });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ name: '书房屏', refreshMinutes: 60 });

    const status = await request(app).get('/api/device/status');
    expect(status.body.data).toMatchObject({ name: '书房屏', refreshMinutes: 60 });

    const display = await request(app).get('/api/display');
    expect(display.body.data.refreshMinutes).toBe(60);
  });

  it('名称过长、刷新间隔越界与空请求体返回 422', async () => {
    expect(
      (await request(app).put('/api/device/settings').send({ name: 'x'.repeat(41) })).status,
    ).toBe(422);
    expect(
      (await request(app).put('/api/device/settings').send({ refreshMinutes: 4 })).status,
    ).toBe(422);
    expect(
      (await request(app).put('/api/device/settings').send({ refreshMinutes: 721 })).status,
    ).toBe(422);
    expect((await request(app).put('/api/device/settings').send({})).status).toBe(422);
    expect(
      (await request(app).put('/api/device/settings').send({ name: '   ' })).status,
    ).toBe(422);
  });
});
