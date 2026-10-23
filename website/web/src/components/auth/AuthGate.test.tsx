// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  setup: { current: undefined as unknown },
  me: { current: undefined as unknown },
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ clear: mocks.clear }),
}));

vi.mock('@/api/use-auth', () => ({
  useSetupStatus: () => mocks.setup.current,
  useMe: () => mocks.me.current,
}));

import { AuthGate } from './AuthGate';

function queryResult(overrides: Record<string, unknown> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

const AUTH_USER = {
  id: 1,
  username: 'admin',
  displayName: '管理员',
  role: 'admin',
  status: 'active',
  timezone: 'Asia/Shanghai',
};

function renderGate(): void {
  render(
    <MemoryRouter initialEntries={['/today']}>
      <Routes>
        <Route
          path="/today"
          element={
            <AuthGate>
              <div>受保护内容</div>
            </AuthGate>
          }
        />
        <Route path="/login" element={<div>登录页</div>} />
        <Route path="/setup" element={<div>初始化页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.clear.mockReset();
  mocks.setup.current = queryResult();
  mocks.me.current = queryResult();
});

afterEach(() => {
  cleanup();
});

describe('AuthGate 路由守卫', () => {
  it('服务端要求初始化时跳转 /setup', () => {
    mocks.setup.current = queryResult({ data: { required: true, codeRequired: false } });
    renderGate();
    expect(screen.getByText('初始化页')).toBeTruthy();
  });

  it('未登录时跳转 /login', () => {
    mocks.setup.current = queryResult({ data: { required: false, codeRequired: false } });
    mocks.me.current = queryResult({ data: undefined });
    renderGate();
    expect(screen.getByText('登录页')).toBeTruthy();
  });

  it('已登录时渲染受保护内容', () => {
    mocks.setup.current = queryResult({ data: { required: false, codeRequired: false } });
    mocks.me.current = queryResult({ data: { user: AUTH_USER } });
    renderGate();
    expect(screen.getByText('受保护内容')).toBeTruthy();
  });

  it('收到 401 事件时先清空查询缓存，再跳转 /login', () => {
    mocks.setup.current = queryResult({ data: { required: false, codeRequired: false } });
    mocks.me.current = queryResult({ data: { user: AUTH_USER } });
    renderGate();
    expect(screen.getByText('受保护内容')).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event('inkpane:unauthorized'));
    });

    expect(mocks.clear).toHaveBeenCalledTimes(1);
    expect(screen.getByText('登录页')).toBeTruthy();
  });

  it('setup 请求失败时渲染重试按钮并可重新请求', () => {
    const refetch = vi.fn();
    mocks.setup.current = queryResult({ isLoading: false, isError: true, refetch });
    renderGate();
    expect(screen.getByText('无法检查初始化状态')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('me 请求失败时渲染重试按钮并可重新请求', () => {
    const refetch = vi.fn();
    mocks.setup.current = queryResult({ data: { required: false, codeRequired: false } });
    mocks.me.current = queryResult({ isError: true, refetch });
    renderGate();
    expect(screen.getByText('无法确认登录状态')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
