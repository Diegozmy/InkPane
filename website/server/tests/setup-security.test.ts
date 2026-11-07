/** 初始化安全：验证码、来源校验与限流。 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import {
  __resetLoginRateLimitForTests,
  __resetSetupRateLimitForTests,
} from '../src/modules/auth/routes.js';
import { __resetSetupCodeForTests } from '../src/modules/auth/setup-code.js';
import { TEST_SETUP_CODE } from './helpers/auth.js';

let app: Express;

const VALID_SETUP = {
  username: 'owner',
  password: 'owner-password-123',
  displayName: '所有者',
  timezone: 'Asia/Shanghai',
};

beforeEach(() => {
  closeDatabase();
  __resetLoginRateLimitForTests();
  __resetSetupRateLimitForTests();
  __resetSetupCodeForTests();
  const db = openDatabase(':memory:');
  runMigrations(db);
  setDatabaseForTesting(db);
  app = createApp();
});

afterAll(() => {
  closeDatabase();
  setDatabaseForTesting(null);
});

describe('初始化验证码', () => {
  it('status 返回 required 与 codeRequired；无码/错码 403，正确码 201', async () => {
    const status = await request(app).get('/api/setup/status');
    expect(status.status).toBe(200);
    expect(status.body.data).toEqual({ required: true, codeRequired: true });

    const missing = await request(app).post('/api/setup').send(VALID_SETUP);
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('FORBIDDEN');

    const wrong = await request(app)
      .post('/api/setup')
      .send({ ...VALID_SETUP, code: '000000' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('FORBIDDEN');

    const ok = await request(app)
      .post('/api/setup')
      .send({ ...VALID_SETUP, code: TEST_SETUP_CODE });
    expect(ok.status).toBe(201);
    expect(ok.body.data.user).toMatchObject({ username: 'owner', role: 'admin' });

    const after = await request(app).get('/api/setup/status');
    expect(after.body.data).toMatchObject({ required: false, codeRequired: true });

    // 已完成后初始化不再可用（即使带正确验证码也返回 409）
    const again = await request(app)
      .post('/api/setup')
      .send({ ...VALID_SETUP, code: TEST_SETUP_CODE });
    expect(again.status).toBe(409);
  });

  it('同一 IP 失败 5 次后，第 6 次请求返回 429 + Retry-After', async () => {
    for (let index = 0; index < 5; index += 1) {
      const response = await request(app)
        .post('/api/setup')
        .send({ ...VALID_SETUP, code: '000000' });
      expect(response.status).toBe(403);
    }

    const limited = await request(app)
      .post('/api/setup')
      .send({ ...VALID_SETUP, code: TEST_SETUP_CODE });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('Origin 校验范围', () => {
  it('setup 写请求校验 Origin，无 Origin 放行；GET status 不受影响', async () => {
    const status = await request(app)
      .get('/api/setup/status')
      .set('Origin', 'http://evil.example');
    expect(status.status).toBe(200);

    const blocked = await request(app)
      .post('/api/setup')
      .set('Origin', 'http://evil.example')
      .send({ ...VALID_SETUP, code: TEST_SETUP_CODE });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('FORBIDDEN');

    // 白名单来源（CORS_ORIGIN）允许
    const allowed = await request(app)
      .post('/api/setup')
      .set('Origin', 'http://localhost:5173')
      .send({ ...VALID_SETUP, code: TEST_SETUP_CODE });
    expect(allowed.status).toBe(201);
  });

  it('局域网地址的同源请求（Origin 与 Host 一致）允许，并返回对应的 CORS 头', async () => {
    const lanHost = '192.168.1.20:5173';
    const origin = `http://${lanHost}`;

    const preflight = await request(app)
      .options('/api/auth/login')
      .set('Host', lanHost)
      .set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);

    const allowed = await request(app)
      .post('/api/setup')
      .set('Host', lanHost)
      .set('Origin', origin)
      .send({ ...VALID_SETUP, code: TEST_SETUP_CODE });
    expect(allowed.status).toBe(201);
  });

  it('登录写请求同样校验 Origin，无 Origin 放行', async () => {
    await request(app)
      .post('/api/setup')
      .send({ ...VALID_SETUP, code: TEST_SETUP_CODE });

    const blocked = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://evil.example')
      .send({ username: 'owner', password: VALID_SETUP.password });
    expect(blocked.status).toBe(403);

    const allowed = await request(app)
      .post('/api/auth/login')
      .send({ username: 'owner', password: VALID_SETUP.password });
    expect(allowed.status).toBe(200);
    expect(allowed.headers['set-cookie']).toBeDefined();
  });
});
