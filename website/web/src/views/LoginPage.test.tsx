// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  status: { current: undefined as unknown },
  me: { current: undefined as unknown },
}));

vi.mock('@/api/use-auth', () => ({
  useSetupStatus: () => mocks.status.current,
  useMe: () => mocks.me.current,
  useLogin: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { LoginPage } from './LoginPage';

function queryResult(overrides: Record<string, unknown> = {}) {
  return { data: undefined, isLoading: false, isError: false, refetch: vi.fn(), ...overrides };
}

function renderLogin(): void {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/today" element={<div>控制台</div>} />
        <Route path="/setup" element={<div>初始化页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.status.current = queryResult({ data: { required: false, codeRequired: false } });
  mocks.me.current = queryResult();
});

afterEach(() => {
  cleanup();
});

describe('LoginPage', () => {
  it('已有登录态时直接进入控制台', () => {
    mocks.me.current = queryResult({
      data: {
        user: {
          id: 1,
          username: 'admin',
          displayName: '管理员',
          role: 'admin',
          status: 'active',
          timezone: 'Asia/Shanghai',
        },
      },
    });
    renderLogin();
    expect(screen.getByText('控制台')).toBeTruthy();
  });

  it('服务端要求初始化时跳转 /setup', () => {
    mocks.status.current = queryResult({ data: { required: true, codeRequired: true } });
    renderLogin();
    expect(screen.getByText('初始化页')).toBeTruthy();
  });

  it('未登录时渲染登录表单', () => {
    renderLogin();
    expect(screen.getByLabelText('用户名')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect(screen.getByRole('button', { name: /登录/ })).toBeTruthy();
  });
});
