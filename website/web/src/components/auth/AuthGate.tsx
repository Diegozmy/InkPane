/** 登录守卫：未初始化去 /setup，未登录去 /login。 */

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useMe, useSetupStatus } from '@/api/use-auth';

function FullScreenHint({ text }: { text: string }): ReactElement {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand__name">InkPane 墨窗</span>
          <span className="brand__sub">桌面信息窗 · 控制台</span>
        </div>
        <p className="muted">{text}</p>
      </div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }): ReactElement {
  const location = useLocation();
  const [unauthorized, setUnauthorized] = useState(false);
  const setup = useSetupStatus();
  const me = useMe(setup.data?.required === false);

  useEffect(() => {
    const onUnauthorized = (): void => setUnauthorized(true);
    window.addEventListener('inkpane:unauthorized', onUnauthorized);
    return () => window.removeEventListener('inkpane:unauthorized', onUnauthorized);
  }, []);

  if (setup.isLoading) return <FullScreenHint text="正在检查服务状态…" />;
  if (setup.isError) {
    return <FullScreenHint text="无法连接后端服务，请确认 API 已启动。" />;
  }
  if (setup.data?.required) {
    return <Navigate to="/setup" replace state={{ from: location.pathname }} />;
  }
  if (unauthorized) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  if (me.isLoading) return <FullScreenHint text="正在确认登录状态…" />;
  if (!me.data) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
