/** 管理员用户管理：创建、编辑、启停与重置密码。 */

import { useState, type FormEvent, type ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { useMe } from '@/api/use-auth';
import { useCreateUser, useResetUserPassword, useUpdateUser, useUsers } from '@/api/use-users';
import { AppShell } from '@/components/layout/AppShell';
import { useShellTopBar } from '@/hooks/use-shell';
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  Field,
  InlineAlert,
  Input,
  Modal,
  Select,
  Skeleton,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import type { UserRole, UserSummary } from '@/types';

const MIN_PASSWORD_LENGTH = 8;

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback;
}

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

  const [editTarget, setEditTarget] = useState<UserSummary | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('user');
  const [editError, setEditError] = useState<string | null>(null);

  const [statusTarget, setStatusTarget] = useState<UserSummary | null>(null);

  const [resetTarget, setResetTarget] = useState<UserSummary | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [resetConfirmValue, setResetConfirmValue] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);

  if (me.data && me.data.user.role !== 'admin') return <Navigate to="/today" replace />;

  const selfId = me.data?.user.id;

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
        onError: (cause) => setError(errorMessage(cause, '创建用户失败')),
      },
    );
  };

  const openEdit = (user: UserSummary): void => {
    setEditTarget(user);
    setEditDisplayName(user.displayName);
    setEditRole(user.role);
    setEditError(null);
  };

  const saveEdit = (): void => {
    if (!editTarget) return;
    const nextName = editDisplayName.trim();
    if (!nextName) {
      setEditError('显示名不能为空');
      return;
    }
    if (nextName.length > 40) {
      setEditError('显示名不能超过 40 个字符');
      return;
    }
    setEditError(null);
    updateUser.mutate(
      { id: editTarget.id, displayName: nextName, role: editRole },
      {
        onSuccess: () => {
          setEditTarget(null);
          setNotice(`已更新用户「${editTarget.username}」`);
          setError(null);
        },
        onError: (cause) => setEditError(errorMessage(cause, '更新用户失败')),
      },
    );
  };

  const toggleStatus = (user: UserSummary): void => {
    const nextStatus = user.status === 'active' ? 'disabled' : 'active';
    updateUser.mutate(
      { id: user.id, status: nextStatus },
      {
        onSuccess: () => {
          setStatusTarget(null);
          setNotice(
            nextStatus === 'disabled'
              ? `已停用用户「${user.username}」，其会话与设备令牌立即失效`
              : `已启用用户「${user.username}」`,
          );
          setError(null);
        },
        onError: (cause) => {
          setStatusTarget(null);
          setError(errorMessage(cause, '更新用户状态失败'));
        },
      },
    );
  };

  const openReset = (user: UserSummary): void => {
    setResetTarget(user);
    setResetPasswordValue('');
    setResetConfirmValue('');
    setResetError(null);
  };

  const submitReset = (): void => {
    if (!resetTarget) return;
    if (resetPasswordValue.length < MIN_PASSWORD_LENGTH) {
      setResetError(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`);
      return;
    }
    if (resetPasswordValue !== resetConfirmValue) {
      setResetError('两次输入的密码不一致');
      return;
    }
    setResetError(null);
    resetPassword.mutate(
      { id: resetTarget.id, password: resetPasswordValue },
      {
        onSuccess: () => {
          setNotice(`已重置用户「${resetTarget.username}」的密码`);
          setResetTarget(null);
          setError(null);
        },
        onError: (cause) => setResetError(errorMessage(cause, '重置密码失败')),
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
              <p className="card__description">
                停用账号会立即撤销该用户的会话与设备令牌；当前登录账号不能停用自己。
              </p>
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
                  {(users.data ?? []).map((user) => {
                    const isSelf = user.id === selfId;
                    return (
                      <tr key={user.id}>
                        <td className="numeric">
                          {user.username}
                          {isSelf && <Badge tone="accent">当前账号</Badge>}
                        </td>
                        <td>{user.displayName}</td>
                        <td>
                          <Badge tone={user.role === 'admin' ? 'success' : 'neutral'}>
                            {user.role === 'admin' ? '管理员' : '用户'}
                          </Badge>
                        </td>
                        <td>
                          <Badge tone={user.status === 'active' ? 'success' : 'warning'}>
                            {user.status === 'active'
                              ? '启用'
                              : user.status === 'disabled'
                                ? '停用'
                                : '待初始化'}
                          </Badge>
                        </td>
                        <td className="numeric">{user.deviceCount}</td>
                        <td className="faint">
                          {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—'}
                        </td>
                        <td>
                          <div className="row row--wrap">
                            <Button size="sm" variant="ghost" onClick={() => openEdit(user)}>
                              编辑
                            </Button>
                            {isSelf ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled
                                title="不能停用当前登录账号"
                              >
                                停用
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                loading={
                                  statusTarget?.id === user.id && updateUser.isPending
                                }
                                disabled={
                                  updateUser.isPending && statusTarget?.id !== user.id
                                }
                                onClick={() => setStatusTarget(user)}
                              >
                                {user.status === 'active' ? '停用' : '启用'}
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => openReset(user)}>
                              重置密码
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <Modal
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="编辑用户"
        description={editTarget ? `@${editTarget.username}` : undefined}
        size="sm"
        footer={
          <>
            <Button onClick={() => setEditTarget(null)} disabled={updateUser.isPending}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={updateUser.isPending}
              onClick={saveEdit}
            >
              保存
            </Button>
          </>
        }
      >
        <div className="stack stack--sm">
          {editError && (
            <InlineAlert tone="danger" title="保存失败">
              {editError}
            </InlineAlert>
          )}
          <Field label="显示名" htmlFor="edit-user-display-name">
            <Input
              id="edit-user-display-name"
              value={editDisplayName}
              maxLength={40}
              onChange={(event) => setEditDisplayName(event.target.value)}
            />
          </Field>
          <Field label="角色" htmlFor="edit-user-role" hint="管理员可以管理用户与查看服务状态">
            <Select
              id="edit-user-role"
              value={editRole}
              onChange={(event) => setEditRole(event.target.value as UserRole)}
            >
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </Select>
          </Field>
        </div>
      </Modal>

      <Modal
        open={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        title="重置密码"
        description={resetTarget ? `为 @${resetTarget.username} 设置新密码` : undefined}
        size="sm"
        footer={
          <>
            <Button onClick={() => setResetTarget(null)} disabled={resetPassword.isPending}>
              取消
            </Button>
            <Button
              variant="danger"
              loading={resetPassword.isPending}
              onClick={submitReset}
            >
              确认重置
            </Button>
          </>
        }
      >
        <div className="stack stack--sm">
          {resetError && (
            <InlineAlert tone="danger" title="重置失败">
              {resetError}
            </InlineAlert>
          )}
          <Field label="新密码" htmlFor="reset-user-password" hint="至少 8 位">
            <Input
              id="reset-user-password"
              type="password"
              value={resetPasswordValue}
              autoComplete="new-password"
              onChange={(event) => setResetPasswordValue(event.target.value)}
            />
          </Field>
          <Field label="确认新密码" htmlFor="reset-user-password-confirm">
            <Input
              id="reset-user-password-confirm"
              type="password"
              value={resetConfirmValue}
              autoComplete="new-password"
              onChange={(event) => setResetConfirmValue(event.target.value)}
            />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={statusTarget !== null}
        title={statusTarget?.status === 'active' ? '停用账号' : '启用账号'}
        message={
          statusTarget?.status === 'active'
            ? `停用「${statusTarget?.username ?? ''}」后，该用户会立即退出登录，设备令牌也会失效。确定吗？`
            : `启用「${statusTarget?.username ?? ''}」后，该用户可以重新登录。确定吗？`
        }
        confirmLabel={statusTarget?.status === 'active' ? '停用' : '启用'}
        tone={statusTarget?.status === 'active' ? 'danger' : 'default'}
        busy={updateUser.isPending}
        onCancel={() => setStatusTarget(null)}
        onConfirm={() => {
          if (statusTarget) toggleStatus(statusTarget);
        }}
      />
    </AppShell>
  );
}
