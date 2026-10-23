/** 登录守卫：未初始化去 /setup，未登录去 /login，登录态失效时先清缓存再跳转。 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useMe, useSetupStatus } from '@/api/use-auth';
import { ErrorState } from '@/components/ui';

function AuthSurface({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand__name">InkPane 墨窗</span>
          <span className="brand__sub">桌面信息窗 · 控制台</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function FullScreenHint({ text }: { text: string }): ReactElement {
  return (
    <AuthSurface>
      <p className="muted">{text}</p>
    </AuthSurface>
  );
}

function FullScreenError({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <AuthSurface>
      <ErrorState title={title} description={description} onRetry={onRetry} />
    </AuthSurface>
  );
}

export function AuthGate({ children }: { children: ReactNode }): ReactElement {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [unauthorized, setUnauthorized] = useState(false);
  const setup = useSetupStatus();
  const me = useMe(setup.data?.required === false);

  useEffect(() => {
    const onUnauthorized = (): void => {
      // 401 说明旧的会话缓存（用户、设备、布局…）已经不可信，先整体清掉再回登录页，
      // 否则重新登录后会短暂看到上一个账号的数据。
      queryClient.clear();
      setUnauthorized(true);
    };
    window.addEventListener('inkpane:unauthorized', onUnauthorized);
    return () => window.removeEventListener('inkpane:unauthorized', onUnauthorized);
  }, [queryClient]);

  // 401 之后查询缓存已被清空，setup / me 都会重新加载；直接去登录页，
  // 不要停在「正在检查服务状态」上等待一次无意义的请求。
  if (unauthorized) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (setup.isLoading) return <FullScreenHint text="正在检查服务状态…" />;
  if (setup.isError) {
    return (
      <FullScreenError
        title="无法检查初始化状态"
        description="无法连接后端服务，请确认 API 已启动后重试。"
        onRetry={() => void setup.refetch()}
      />
    );
  }
  if (setup.data?.required) {
    return <Navigate to="/setup" replace state={{ from: location.pathname }} />;
  }
  if (me.isLoading) return <FullScreenHint text="正在确认登录状态…" />;
  if (me.isError) {
    return (
      <FullScreenError
        title="无法确认登录状态"
        description="登录态校验请求失败，请检查后端服务后重试。"
        onRetry={() => void me.refetch()}
      />
    );
  }
  if (!me.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
