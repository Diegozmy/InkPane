/** 多用户、会话、CSRF 与跨租户隔离的集成测试。 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { __resetLoginRateLimitForTests } from '../src/modules/auth/routes.js';
import { createTestDevice, createTestUser, loginTestUser, setupTestAdmin } from './helpers/auth.js';

let app: Express;
let admin: Awaited<ReturnType<typeof setupTestAdmin>>;

beforeEach(async () => {
  closeDatabase();
  __resetLoginRateLimitForTests();
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

describe('初始化与登录', () => {
  it('首次初始化创建管理员，之后 setup 不再可用', async () => {
    const status = await request(app).get('/api/setup/status');
    expect(status.body.data.required).toBe(false);

    const me = await admin.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user).toMatchObject({ username: 'admin', role: 'admin' });

    const again = await request(app).post('/api/setup').send({
      username: 'another',
      password: 'another-password',
    });
    expect(again.status).toBe(409);
  });

  it('退出后会话失效，错误密码返回 401，连续失败触发限流', async () => {
    await admin.post('/api/auth/logout');
    expect((await admin.get('/api/auth/me')).status).toBe(401);

    const bad = await request(app).post('/api/auth/login').send({
      username: 'admin',
      password: 'wrong-password',
    });
    expect(bad.status).toBe(401);

    for (let index = 0; index < 5; index += 1) {
      await request(app).post('/api/auth/login').send({
        username: 'admin',
        password: 'wrong-password',
      });
    }
    const limited = await request(app).post('/api/auth/login').send({
      username: 'admin',
      password: 'wrong-password',
    });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('跨站 Origin 的写请求被拒绝', async () => {
    const response = await admin
      .post('/api/categories')
      .set('Origin', 'http://evil.example')
      .send({ name: '攻击', color: '#111111' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});

describe('用户隔离', () => {
  it('普通用户只能看到自己的日程，跨用户 id 返回 404', async () => {
    await createTestUser(admin, 'alice');
    await createTestUser(admin, 'bob');
    const alice = await loginTestUser(app, 'alice', 'user-password-123');
    const bob = await loginTestUser(app, 'bob', 'user-password-123');

    const created = await alice.post('/api/events').send({
      title: 'Alice 的会议',
      startAt: '2026-10-20T01:00:00.000Z',
      endAt: '2026-10-20T02:00:00.000Z',
      timezone: 'Asia/Shanghai',
    });
    expect(created.status).toBe(201);
    const eventId = created.body.data.id as number;

    const aliceList = await alice.get('/api/events');
    expect(aliceList.body.data).toHaveLength(1);
    const bobList = await bob.get('/api/events');
    expect(bobList.body.data).toHaveLength(0);

    expect((await bob.get(`/api/events/${eventId}`)).status).toBe(404);
    expect((await bob.patch(`/api/events/${eventId}`).send({ title: '劫持' })).status).toBe(404);
    expect((await bob.delete(`/api/events/${eventId}`)).status).toBe(404);
  });

  it('设备令牌绑定到所属用户，A 的屏幕数据不会出现 B 的日程', async () => {
    await createTestUser(admin, 'carol');
    const carol = await loginTestUser(app, 'carol', 'user-password-123');
    await carol.post('/api/events').send({
      title: 'Carol 的课程',
      allDay: true,
      startAt: '2026-10-20',
      endAt: '2026-10-20',
      timezone: 'Asia/Shanghai',
    });

    const device = await createTestDevice(admin, '管理员设备');
    const screen = await request(app)
      .get('/api/device/screen')
      .set('X-Device-Token', device.token);
    expect(screen.status).toBe(200);
    expect(
      (screen.body.data.events as { title: string }[]).map((event) => event.title),
    ).not.toContain('Carol 的课程');
  });
});

describe('管理员边界', () => {
  it('普通用户访问用户管理返回 403，停用用户后会话失效', async () => {
    const alice = await createTestUser(admin, 'dave');
    const aliceAgent = await loginTestUser(app, 'dave', 'user-password-123');
    expect((await aliceAgent.get('/api/users')).status).toBe(403);

    const disabled = await admin.patch(`/api/users/${alice.id}`).send({ status: 'disabled' });
    expect(disabled.status).toBe(200);
    expect((await aliceAgent.get('/api/todos')).status).toBe(401);
  });

  it('用户 CRUD：创建、列出、改名、重置密码、停用', async () => {
    const created = await createTestUser(admin, 'erin');

    const list = await admin.get('/api/users');
    expect(list.status).toBe(200);
    expect(
      (list.body.data as { id: number; username: string }[]).some(
        (user) => user.id === created.id && user.username === 'erin',
      ),
    ).toBe(true);

    const renamed = await admin
      .patch(`/api/users/${created.id}`)
      .send({ displayName: 'Erin', role: 'user' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data).toMatchObject({ id: created.id, displayName: 'Erin', role: 'user' });

    // 重置密码会撤销该用户现有会话
    const oldSession = await loginTestUser(app, 'erin', 'user-password-123');
    const reset = await admin
      .post(`/api/users/${created.id}/password`)
      .send({ password: 'new-password-456' });
    expect(reset.status).toBe(200);
    expect((await oldSession.get('/api/auth/me')).status).toBe(401);

    const newSession = await loginTestUser(app, 'erin', 'new-password-456');
    expect((await newSession.get('/api/auth/me')).status).toBe(200);

    const disabled = await admin.patch(`/api/users/${created.id}`).send({ status: 'disabled' });
    expect(disabled.status).toBe(200);
    expect((await newSession.get('/api/auth/me')).status).toBe(401);
  });

  it('撤销设备后令牌立即 401；停用用户后其设备令牌同样失效', async () => {
    const user = await createTestUser(admin, 'frank');
    const frank = await loginTestUser(app, 'frank', 'user-password-123');
    const device = await createTestDevice(frank, 'Frank 屏');

    const screen = () =>
      request(app).get('/api/device/screen').set('X-Device-Token', device.token);
    expect((await screen()).status).toBe(200);

    expect((await frank.delete(`/api/devices/${device.id}`)).status).toBe(200);
    expect((await screen()).status).toBe(401);

    // 再建一台设备，停用账号后同样 401（设备解析要求用户状态 active）
    const second = await createTestDevice(frank, 'Frank 第二屏');
    expect(
      (await request(app).get('/api/device/screen').set('X-Device-Token', second.token)).status,
    ).toBe(200);
    await admin.patch(`/api/users/${user.id}`).send({ status: 'disabled' });
    expect(
      (await request(app).get('/api/device/screen').set('X-Device-Token', second.token)).status,
    ).toBe(401);
  });
});
