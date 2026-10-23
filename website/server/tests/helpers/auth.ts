/** 测试辅助：初始化管理员、创建用户、登录与设备令牌。 */

import request from 'supertest';
import type { Express } from 'express';
import { __resetSetupCodeForTests } from '../../src/modules/auth/setup-code.js';
import { __resetSetupRateLimitForTests } from '../../src/modules/auth/routes.js';

export const TEST_ADMIN = { username: 'admin', password: 'admin-password-123' };

/** 与 vitest.config.ts 中的 INKPANE_SETUP_CODE 保持一致。 */
export const TEST_SETUP_CODE = 'test-setup-code';

export async function setupTestAdmin(app: Express) {
  // 每个用例通常使用新的内存数据库；验证码状态与限流计数都是进程级的，测试间需要重置。
  __resetSetupCodeForTests();
  __resetSetupRateLimitForTests();
  const agent = request.agent(app);
  const response = await agent.post('/api/setup').send({
    username: TEST_ADMIN.username,
    password: TEST_ADMIN.password,
    displayName: '测试管理员',
    timezone: 'Asia/Shanghai',
    code: TEST_SETUP_CODE,
  });
  if (response.status !== 201) {
    throw new Error(`初始化测试管理员失败：${response.status} ${JSON.stringify(response.body)}`);
  }
  return agent;
}

export async function createTestUser(
  admin: ReturnType<typeof request.agent>,
  username: string,
  password = 'user-password-123',
) {
  const response = await admin.post('/api/users').send({
    username,
    password,
    displayName: username,
    role: 'user',
  });
  if (response.status !== 201) {
    throw new Error(`创建测试用户失败：${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.data as { id: number; username: string };
}

export async function loginTestUser(app: Express, username: string, password: string) {
  const agent = request.agent(app);
  const response = await agent.post('/api/auth/login').send({ username, password });
  if (response.status !== 200) {
    throw new Error(`登录测试用户失败：${response.status} ${JSON.stringify(response.body)}`);
  }
  return agent;
}

export async function createTestDevice(
  agent: ReturnType<typeof request.agent>,
  name = '测试设备',
): Promise<{ id: number; token: string }> {
  const response = await agent.post('/api/devices').send({ name });
  if (response.status !== 201) {
    throw new Error(`创建设备失败：${response.status} ${JSON.stringify(response.body)}`);
  }
  return { id: response.body.data.device.id as number, token: response.body.data.token as string };
}
