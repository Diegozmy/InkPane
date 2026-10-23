/** 管理员用户管理。 */

import { useState, type FormEvent, type ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '@/api/use-auth';
import { useCreateUser, useResetUserPassword, useUpdateUser, useUsers } from '@/api/use-users';
import { AppShell } from '@/components/layout/AppShell';
import { useShellTopBar } from '@/hooks/use-shell';
import { Badge, Button, ErrorState, Field, InlineAlert, Input, Select, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api';
import type { UserRole } from '@/types';

export function UsersPage(): ReactElement {
  const topbar = useShellTopBar({ showFilters: false });
  const me = useMe();
  const users = useUsers(me.data?.user.role === 'admin');
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const resetPassword = useResetUserPassword();

  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (me.data && me.data.user.role !== 'admin') return <Navigate to="/today" replace />;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    createUser.mutate(
      {
        username: username.trim(),
        password,
        displayName: displayName.trim() || undefined,
        role,
      },
      {
        onSuccess: () => {
          setUsername('');
          setDisplayName('');
          setPassword('');
          setRole('user');
          setNotice('用户已创建');
        },
        onError: (cause) =>
          setError(cause instanceof ApiError ? cause.message : '创建用户失败'),
      },
    );
  };

  return (
    <AppShell topbar={topbar}>
      <div className="page page--wide">
        <header className="page__header">
          <div className="page__heading">
            <p className="page__eyebrow">Users · 账户</p>
            <h1 className="page__title">用户管理</h1>
            <p className="page__subtitle">
              每个用户拥有独立的日程、待办、天气、课程与设备。管理员只能管理账号，不能查看其他用户的内容数据。
            </p>
          </div>
        </header>

        {error && <InlineAlert tone="danger" title="操作失败">{error}</InlineAlert>}
        {notice && <InlineAlert tone="success" title="完成">{notice}</InlineAlert>}

        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">创建用户</h2>
              <p className="card__description">新用户首次登录后可以自行修改密码与显示名。</p>
            </div>
          </div>
          <form className="form-grid" onSubmit={submit}>
            <Field label="用户名" htmlFor="new-user-username">
              <Input
                id="new-user-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="显示名" htmlFor="new-user-display-name">
              <Input
                id="new-user-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </Field>
            <Field label="初始密码" htmlFor="new-user-password" hint="至少 8 位">
              <Input
                id="new-user-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <Field label="角色" htmlFor="new-user-role">
              <Select
                id="new-user-role"
                value={role}
                onChange={(event) => setRole(event.target.value as UserRole)}
              >
                <option value="user">普通用户</option>
                <option value="admin">管理员</option>
              </Select>
            </Field>
            <div className="row">
              <Button type="submit" variant="primary" loading={createUser.isPending}>
                创建用户
              </Button>
            </div>
          </form>
        </section>

        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">全部用户</h2>
              <p className="card__description">停用账号会立即撤销该用户的会话与设备令牌。</p>
            </div>
          </div>
          {users.isLoading ? (
            <div className="stack stack--sm">
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
          ) : users.isError ? (
            <ErrorState
              title="用户列表加载失败"
              description="请确认当前账号有管理员权限。"
              detail={users.error instanceof Error ? users.error.message : undefined}
              onRetry={() => void users.refetch()}
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>用户名</th>
                    <th>显示名</th>
                    <th>角色</th>
                    <th>状态</th>
                    <th>设备</th>
                    <th>最近登录</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {(users.data ?? []).map((user) => (
                    <tr key={user.id}>
                      <td className="numeric">{user.username}</td>
                      <td>{user.displayName}</td>
                      <td>
                        <Badge tone={user.role === 'admin' ? 'success' : 'neutral'}>
                          {user.role === 'admin' ? '管理员' : '用户'}
                        </Badge>
                      </td>
                      <td>
                        <Badge tone={user.status === 'active' ? 'success' : 'warning'}>
                          {user.status === 'active' ? '启用' : user.status === 'disabled' ? '停用' : '待初始化'}
                        </Badge>
                      </td>
                      <td className="numeric">{user.deviceCount}</td>
                      <td className="faint">
                        {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—'}
                      </td>
                      <td>
                        <div className="row row--wrap">
                          {user.id !== me.data?.user.id && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                updateUser.mutate({
                                  id: user.id,
                                  status: user.status === 'active' ? 'disabled' : 'active',
                                })
                              }
                            >
                              {user.status === 'active' ? '停用' : '启用'}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              const next = window.prompt(`为 ${user.username} 设置新密码（至少 8 位）`);
                              if (next && next.length >= 8) {
                                resetPassword.mutate({ id: user.id, password: next });
                              }
                            }}
                          >
                            重置密码
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
