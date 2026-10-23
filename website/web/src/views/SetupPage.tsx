/** 首次初始化：创建管理员账号（非回环访问时需要服务端打印的初始化码）。 */

import { useState, type FormEvent, type ReactElement } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useSetup, useSetupStatus } from '@/api/use-auth';
import { Button, ErrorState, Field, InlineAlert, Input } from '@/components/ui';
import { ApiError } from '@/lib/api';

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export function SetupPage(): ReactElement {
  const navigate = useNavigate();
  const status = useSetupStatus();
  const setup = useSetup();
  const [username, setUsername] = useState('admin');
  const [displayName, setDisplayName] = useState('管理员');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone);
  const [error, setError] = useState<string | null>(null);

  if (status.isLoading) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <p className="muted">正在检查初始化状态…</p>
        </div>
      </div>
    );
  }

  if (status.isError) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <ErrorState
            title="无法检查初始化状态"
            description="无法连接后端服务，请确认 API 已启动后重试。"
            onRetry={() => void status.refetch()}
          />
        </div>
      </div>
    );
  }

  if (status.data && !status.data.required) return <Navigate to="/login" replace />;

  const codeRequired = status.data?.codeRequired === true;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    if (codeRequired && code.trim().length === 0) {
      setError('请输入服务端日志里打印的初始化码');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setup.mutate(
      {
        username: username.trim(),
        password,
        displayName: displayName.trim(),
        timezone: timezone.trim(),
        ...(codeRequired ? { code: code.trim() } : {}),
      },
      {
        onSuccess: () => navigate('/today', { replace: true }),
        onError: (cause) => {
          setError(cause instanceof ApiError ? cause.message : '初始化失败，请稍后重试');
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
            <span className="brand__sub">首次初始化</span>
          </span>
        </div>

        <div>
          <h1 className="auth-title">创建管理员</h1>
          <p className="muted">
            这个账号只用于管理控制台。之后可以在「用户管理」里为家人或同学创建独立账号，
            每个人的日程、待办和设备互相隔离。
          </p>
        </div>

        {error && <InlineAlert tone="danger" title="初始化失败">{error}</InlineAlert>}

        <form className="stack stack--lg" onSubmit={submit}>
          {codeRequired && (
            <Field
              label="初始化码"
              htmlFor="setup-code"
              hint="服务端启动时在日志里打印的一次性 6 位码（也可由 INKPANE_SETUP_CODE 固定）"
            >
              <Input
                id="setup-code"
                value={code}
                autoComplete="one-time-code"
                inputMode="numeric"
                placeholder="例如：123456"
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
          )}
          <Field label="管理员用户名" htmlFor="setup-username" hint="3–32 位字母、数字、点、下划线或短横线">
            <Input
              id="setup-username"
              value={username}
              autoComplete="username"
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label="显示名" htmlFor="setup-display-name">
            <Input
              id="setup-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </Field>
          <Field label="密码" htmlFor="setup-password" hint="至少 8 位">
            <Input
              id="setup-password"
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Field label="确认密码" htmlFor="setup-confirm">
            <Input
              id="setup-confirm"
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(event) => setConfirm(event.target.value)}
            />
          </Field>
          <Field label="显示时区" htmlFor="setup-timezone" hint="决定「今天」、月历与设备屏幕的日界线">
            <Input
              id="setup-timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" size="md" block loading={setup.isPending}>
            创建并进入控制台
          </Button>
        </form>
      </div>
    </div>
  );
}
