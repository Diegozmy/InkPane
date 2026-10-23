/** 登录页。 */

import { useState, type FormEvent, type ReactElement } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useLogin, useMe, useSetupStatus } from '@/api/use-auth';
import { Button, Field, InlineAlert, Input } from '@/components/ui';
import { ApiError } from '@/lib/api';

export function LoginPage(): ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const setup = useSetupStatus();
  const me = useMe();
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (setup.data?.required) return <Navigate to="/setup" replace />;
  // 已经有会话时直接进入控制台，避免「已登录还停留在登录页」。
  if (me.data) return <Navigate to="/today" replace />;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    login.mutate(
      { username: username.trim(), password },
      {
        onSuccess: () => {
          const from = (location.state as { from?: string } | null)?.from;
          navigate(from && from !== '/login' ? from : '/today', { replace: true });
        },
        onError: (cause) => {
          setError(cause instanceof ApiError ? cause.message : '登录失败，请稍后重试');
        },
      },
    );
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand__mark" aria-hidden="true">
            <span />
          </span>
          <span>
            <span className="brand__name">InkPane 墨窗</span>
            <span className="brand__sub">桌面信息窗 · 控制台</span>
          </span>
        </div>

        <div>
          <h1 className="auth-title">登录</h1>
          <p className="muted">用管理员或用户账号进入控制台。</p>
        </div>

        {error && <InlineAlert tone="danger" title="登录失败">{error}</InlineAlert>}

        <form className="stack stack--lg" onSubmit={submit}>
          <Field label="用户名" htmlFor="login-username">
            <Input
              id="login-username"
              value={username}
              autoComplete="username"
              autoFocus
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label="密码" htmlFor="login-password">
            <Input
              id="login-password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" size="md" block loading={login.isPending}>
            登录
          </Button>
        </form>

        <p className="faint auth-footnote">
          首次使用？<Link to="/setup">初始化管理员账号</Link>
        </p>
      </div>
    </div>
  );
}
