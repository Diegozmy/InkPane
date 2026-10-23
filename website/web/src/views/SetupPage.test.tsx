// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  status: { current: undefined as unknown },
  setup: { current: undefined as unknown },
  mutate: vi.fn(),
}));

vi.mock('@/api/use-auth', () => ({
  useSetupStatus: () => mocks.status.current,
  useSetup: () => mocks.setup.current,
}));

import { SetupPage } from './SetupPage';

function renderSetup(): void {
  render(
    <MemoryRouter initialEntries={['/setup']}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/today" element={<div>控制台</div>} />
        <Route path="/login" element={<div>登录页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillPasswords(): void {
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password123' } });
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'password123' } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: /创建并进入控制台/ }));
}

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.status.current = {
    data: { required: true, codeRequired: true },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
  mocks.setup.current = { mutate: mocks.mutate, isPending: false };
});

afterEach(() => {
  cleanup();
});

describe('SetupPage 初始化码', () => {
  it('服务端要求初始化码时渲染输入框', () => {
    renderSetup();
    expect(screen.getByLabelText('初始化码')).toBeTruthy();
  });

  it('提交时把去掉空白后的初始化码一起发给服务端', () => {
    renderSetup();
    fireEvent.change(screen.getByLabelText('初始化码'), { target: { value: ' 123456 ' } });
    fillPasswords();
    submit();

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    const payload = mocks.mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      username: 'admin',
      code: '123456',
      password: 'password123',
    });
  });

  it('缺少初始化码时拦截提交', () => {
    renderSetup();
    fillPasswords();
    submit();

    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByText('请输入服务端日志里打印的初始化码')).toBeTruthy();
  });

  it('不需要初始化码时不渲染输入框，也不发送 code 字段', () => {
    mocks.status.current = {
      data: { required: true, codeRequired: false },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
    renderSetup();

    expect(screen.queryByLabelText('初始化码')).toBeNull();
    fillPasswords();
    submit();

    const payload = mocks.mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('code');
  });
});
