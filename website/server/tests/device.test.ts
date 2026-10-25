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
import { __resetDeviceWriteRateLimitForTests } from '../src/modules/device/routes.js';
import {
  createTestDevice,
  createTestUser,
  loginTestUser,
  setupTestAdmin,
} from './helpers/auth.js';

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

function currentUserId(): number {
  return Number(
    (getDatabase().prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number }).id,
  );
}

/** 把日程标记为课程（插入 course_slot_links 映射）。 */
function linkCourse(eventId: number, title: string, externalKey: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO course_slot_links (user_id, source, external_key, event_id, title, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(currentUserId(), 'test-source', externalKey, eventId, title, new Date().toISOString());
}

beforeEach(async () => {
  closeDatabase();
  // 限流器是进程内状态，测试之间必须清空，否则跨用例累计会误触发 429。
  __resetDeviceWriteRateLimitForTests();
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

  it('数组按屏幕容量截断，并返回真实 totals', async () => {
    const created = await createTestDevice(agent);

    for (let index = 0; index < 40; index += 1) {
      await createTodayEvent({ title: `日程 ${index}` });
    }
    for (let index = 0; index < 20; index += 1) {
      const eventId = await createTodayEvent({ title: `课程 ${index}` });
      linkCourse(eventId, `课程 ${index}`, `test-source:course:${index}`);
    }
    for (let index = 0; index < 10; index += 1) {
      await agent.post('/api/todos').send({ title: `待办 ${index}` });
    }

    const response = await getScreen(created.token);
    expect(response.status).toBe(200);
    const payload = response.body.data;

    expect(payload.events).toHaveLength(32);
    expect(payload.eventTotal).toBe(40);
    expect(payload.courses).toHaveLength(16);
    expect(payload.courseTotal).toBe(20);
    expect(payload.todos).toHaveLength(8);
    expect(payload.todoTotal).toBe(10);
  });

  it('ETag 覆盖 totals：数组已截断时新增条目仍会改变 ETag', async () => {
    const created = await createTestDevice(agent);
    for (let index = 0; index < 32; index += 1) {
      await createTodayEvent({ title: `日程 ${index}` });
    }

    const first = await getScreen(created.token);
    expect(first.body.data.events).toHaveLength(32);
    expect(first.body.data.eventTotal).toBe(32);
    const etag = first.headers.etag as string;

    // 第 33 条不会出现在数组里，但 eventTotal 变化必须让 ETag 失效
    await createTodayEvent({ title: '第 33 条' });
    const second = await getScreen(created.token, { 'If-None-Match': etag });
    expect(second.status).toBe(200);
    expect(second.body.data.events).toHaveLength(32);
    expect(second.body.data.eventTotal).toBe(33);
    expect(second.headers.etag).not.toBe(etag);
  });

  it('ETag 覆盖 todoTotal：完成不在前 8 条的待办也会改变 ETag', async () => {
    const created = await createTestDevice(agent);
    const todoIds: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await agent.post('/api/todos').send({ title: `待办 ${index}` });
      todoIds.push(response.body.data.id as number);
    }

    const first = await getScreen(created.token);
    expect(first.body.data.todos).toHaveLength(8);
    expect(first.body.data.todoTotal).toBe(10);
    const etag = first.headers.etag as string;
    const visibleIds = (first.body.data.todos as { id: number }[]).map((todo) => todo.id);

    // 最后创建的待办不在前 8 条里，完成它不改变 todos 数组，只改变 todoTotal
    const hiddenId = todoIds.find((id) => !visibleIds.includes(id));
    expect(hiddenId).toBeDefined();
    await agent.patch(`/api/todos/${hiddenId!}`).send({ done: true });

    const second = await getScreen(created.token, { 'If-None-Match': etag });
    expect(second.status).toBe(200);
    expect(second.body.data.todos).toEqual(first.body.data.todos);
    expect(second.body.data.todoTotal).toBe(9);
    expect(second.headers.etag).not.toBe(etag);
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

/* ------------------------------------------------------------------ *
 * 语音助手：设备上下文与写接口
 * ------------------------------------------------------------------ */

describe('设备上下文与写接口鉴权', () => {
  it('没有令牌时 context 与全部写接口都返回 401', async () => {
    expect((await request(app).get('/api/device/context')).status).toBe(401);
    expect(
      (await request(app).post('/api/device/events').send({
        title: '无令牌',
        startAt: today(),
        endAt: today(),
      })).status,
    ).toBe(401);
    expect(
      (await request(app).patch('/api/device/events/1').send({ title: '无令牌' })).status,
    ).toBe(401);
    expect((await request(app).delete('/api/device/events/1')).status).toBe(401);
    expect((await request(app).post('/api/device/todos').send({ title: '无令牌' })).status).toBe(
      401,
    );
    expect((await request(app).patch('/api/device/todos/1').send({ done: true })).status).toBe(401);
    expect((await request(app).delete('/api/device/todos/1')).status).toBe(401);
  });

  it('context 返回今日日程、课程、待办与时间信息', async () => {
    const created = await createTestDevice(agent);
    const day = today();

    const eventId = await createTodayEvent({ title: '晨会', location: '二楼会议室' });
    const courseId = await createTodayEvent({ title: '数学' });
    linkCourse(courseId, '数学', 'context:1:1');
    const todo = await agent
      .post('/api/todos')
      .send({ title: '交作业', priority: 'urgent', dueDate: day });

    const response = await request(app)
      .get('/api/device/context')
      .set(TOKEN_HEADER, created.token);
    expect(response.status).toBe(200);
    const data = response.body.data;

    expect(data.now).toMatchObject({ date: day, timezone: TZ, utcOffsetMinutes: 480 });
    expect(data.now.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(data.now.time).toMatch(/^\d{2}:\d{2}$/);
    expect(data.now.weekday).toMatch(/^周[一二三四五六日]$/);

    const eventItems = data.events as {
      id: string;
      title: string;
      eventId: number;
    }[];
    const event = eventItems.find((item) => item.title === '晨会');
    expect(event).toMatchObject({
      eventId,
      title: '晨会',
      location: '二楼会议室',
      allDay: true,
      isCourse: false,
    });
    expect(String(event?.id)).toContain(`${eventId}:`);
    expect(eventItems.map((item) => item.title)).not.toContain('数学');

    const course = (data.courses as { title: string }[]).find((item) => item.title === '数学');
    expect(course).toMatchObject({ eventId: courseId, isCourse: true });

    expect(data.todos).toEqual([
      { id: todo.body.data.id, title: '交作业', dueDate: day, priority: 'urgent' },
    ]);
  });

  it('context 按输出上限截断：日程 20、课程 20、待办 10', async () => {
    const created = await createTestDevice(agent);
    for (let index = 0; index < 22; index += 1) {
      await createTodayEvent({ title: `日程 ${index}` });
    }
    for (let index = 0; index < 22; index += 1) {
      const eventId = await createTodayEvent({ title: `课程 ${index}` });
      linkCourse(eventId, `课程 ${index}`, `context:course:${index}`);
    }
    for (let index = 0; index < 12; index += 1) {
      await agent.post('/api/todos').send({ title: `待办 ${index}` });
    }

    const response = await request(app)
      .get('/api/device/context')
      .set(TOKEN_HEADER, created.token);
    expect(response.status).toBe(200);
    expect(response.body.data.events).toHaveLength(20);
    expect(response.body.data.courses).toHaveLength(20);
    expect(response.body.data.todos).toHaveLength(10);
  });
});

describe('设备写接口', () => {
  it('创建、更新、删除日程并返回完整实体', async () => {
    const created = await createTestDevice(agent);
    const day = today();

    const post = await request(app)
      .post('/api/device/events')
      .set(TOKEN_HEADER, created.token)
      .send({ title: '语音创建', allDay: true, startAt: day, endAt: day });
    expect(post.status).toBe(201);
    expect(post.body.data).toMatchObject({
      title: '语音创建',
      allDay: true,
      startAt: day,
      endAt: day,
      priority: 'normal',
      status: 'confirmed',
    });
    const eventId = post.body.data.id as number;
    expect((await agent.get(`/api/events/${eventId}`)).status).toBe(200);

    const patch = await request(app)
      .patch(`/api/device/events/${eventId}`)
      .set(TOKEN_HEADER, created.token)
      .send({ title: '语音改名', location: '客厅' });
    expect(patch.status).toBe(200);
    expect(patch.body.data).toMatchObject({ id: eventId, title: '语音改名', location: '客厅' });

    const removed = await request(app)
      .delete(`/api/device/events/${eventId}`)
      .set(TOKEN_HEADER, created.token);
    expect(removed.status).toBe(204);
    expect(removed.text).toBe('');
    expect((await agent.get(`/api/events/${eventId}`)).status).toBe(404);
  });

  it('创建、完成、删除待办并返回完整实体', async () => {
    const created = await createTestDevice(agent);
    const day = today();

    const post = await request(app)
      .post('/api/device/todos')
      .set(TOKEN_HEADER, created.token)
      .send({ title: '语音待办', priority: 'high', dueDate: day });
    expect(post.status).toBe(201);
    expect(post.body.data).toMatchObject({
      title: '语音待办',
      done: false,
      priority: 'high',
      dueDate: day,
    });
    const todoId = post.body.data.id as number;

    const patch = await request(app)
      .patch(`/api/device/todos/${todoId}`)
      .set(TOKEN_HEADER, created.token)
      .send({ done: true });
    expect(patch.status).toBe(200);
    expect(patch.body.data).toMatchObject({ id: todoId, done: true });
    expect(patch.body.data.completedAt).toBeTruthy();

    const removed = await request(app)
      .delete(`/api/device/todos/${todoId}`)
      .set(TOKEN_HEADER, created.token);
    expect(removed.status).toBe(204);
    expect((await agent.get(`/api/todos/${todoId}`)).status).toBe(404);
  });

  it('非法 schema 与非法 id 返回 422', async () => {
    const created = await createTestDevice(agent);
    const header = { [TOKEN_HEADER]: created.token };
    const day = today();

    const cases = [
      request(app).post('/api/device/events').set(header).send({ title: '', startAt: day, endAt: day }),
      request(app)
        .post('/api/device/events')
        .set(header)
        .send({ title: '多字段', startAt: day, endAt: day, unknownField: 1 }),
      request(app).post('/api/device/todos').set(header).send({ title: '多字段', unknownField: 1 }),
      request(app).post('/api/device/todos').set(header).send({ title: 'x'.repeat(201) }),
      request(app).patch('/api/device/events/abc').set(header).send({ title: '非法 id' }),
      request(app).delete('/api/device/todos/0').set(header),
    ];

    for (const response of await Promise.all(cases)) {
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('设备令牌只能用所属用户的数据，跨用户 id 返回 404', async () => {
    await createTestUser(agent, 'alice');
    const alice = await loginTestUser(app, 'alice', 'user-password-123');
    const day = today();

    const aliceEvent = await alice
      .post('/api/events')
      .send({ title: 'Alice 日程', allDay: true, startAt: day, endAt: day });
    const aliceEventId = aliceEvent.body.data.id as number;
    const aliceTodo = await alice.post('/api/todos').send({ title: 'Alice 待办' });
    const aliceTodoId = aliceTodo.body.data.id as number;

    const adminDevice = await createTestDevice(agent, '管理员设备');
    const header = { [TOKEN_HEADER]: adminDevice.token };

    expect(
      (await request(app)
        .patch(`/api/device/events/${aliceEventId}`)
        .set(header)
        .send({ title: '劫持' })).status,
    ).toBe(404);
    expect(
      (await request(app).delete(`/api/device/events/${aliceEventId}`).set(header)).status,
    ).toBe(404);
    expect(
      (await request(app)
        .patch(`/api/device/todos/${aliceTodoId}`)
        .set(header)
        .send({ done: true })).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/device/todos/${aliceTodoId}`).set(header)).status).toBe(
      404,
    );

    const created = await request(app)
      .post('/api/device/events')
      .set(header)
      .send({ title: '管理员日程', allDay: true, startAt: day, endAt: day });
    expect(created.status).toBe(201);

    const aliceTitles = (await alice.get('/api/events')).body.data as { title: string }[];
    const adminTitles = (await agent.get('/api/events')).body.data as { title: string }[];
    expect(aliceTitles.map((item) => item.title)).not.toContain('管理员日程');
    expect(adminTitles.map((item) => item.title)).toContain('管理员日程');

    const aliceContext = await request(app)
      .get('/api/device/context')
      .set('X-Device-Token', (await createTestDevice(alice, 'Alice 屏')).token);
    expect((aliceContext.body.data.events as { title: string }[]).map((item) => item.title)).toContain(
      'Alice 日程',
    );
    expect(
      (aliceContext.body.data.events as { title: string }[]).map((item) => item.title),
    ).not.toContain('管理员日程');
  });

  it('写接口按设备限流 20 次/60s，读接口与其它设备不受影响', async () => {
    const created = await createTestDevice(agent);
    const header = { [TOKEN_HEADER]: created.token };

    for (let index = 0; index < 20; index += 1) {
      const response = await request(app)
        .post('/api/device/todos')
        .set(header)
        .send({ title: `限流待办 ${index}` });
      expect(response.status).toBe(201);
    }

    const limited = await request(app)
      .post('/api/device/todos')
      .set(header)
      .send({ title: '第 21 次' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();

    expect((await request(app).get('/api/device/context').set(header)).status).toBe(200);

    const other = await createTestDevice(agent, '另一台设备');
    const otherWrite = await request(app)
      .post('/api/device/todos')
      .set(TOKEN_HEADER, other.token)
      .send({ title: '新设备不受影响' });
    expect(otherWrite.status).toBe(201);
  });
});
