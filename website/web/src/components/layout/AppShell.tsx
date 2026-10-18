/** 应用外壳：顶栏 + 侧栏 + 主内容 + 移动端抽屉与底部标签栏。 */

import { useEffect, type ReactElement, type ReactNode } from 'react';
import { useUiStore } from '@/store/ui-store';
import { IconButton } from '@/components/ui/primitives';
import { MobileTabBar } from './MobileTabBar';
import { TopBar, type TopBarProps } from './TopBar';

export interface AppShellProps {
  topbar: Omit<TopBarProps, 'onOpenSidebar' | 'onOpenFilters' | 'activeFilterCount'> & {
    onOpenFilters: () => void;
    activeFilterCount: number;
  };
  sidebar: ReactNode;
  children: ReactNode;
}

export function AppShell({ topbar, sidebar, children }: AppShellProps): ReactElement {
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);

  /* 抽屉打开时锁定背景滚动，并用 Esc 关闭 */
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sidebarOpen, setSidebarOpen]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <TopBar
        {...topbar}
        onOpenSidebar={() => setSidebarOpen(true)}
        onOpenFilters={topbar.onOpenFilters}
        activeFilterCount={topbar.activeFilterCount}
      />

      <div className="app-body">
        <aside className="sidebar" aria-label="侧栏">
          {sidebar}
        </aside>
        <main className="main" id="main-content">
          {children}
        </main>
      </div>

      {sidebarOpen && (
        <>
          <div
            className="drawer-backdrop"
            role="presentation"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="drawer" aria-label="侧栏（抽屉）">
            <div className="row row--between">
              <span className="section-title">导航与筛选</span>
              <IconButton
                icon="close"
                label="关闭侧栏"
                onClick={() => setSidebarOpen(false)}
              />
            </div>
            {sidebar}
          </aside>
        </>
      )}

      <MobileTabBar />
    </div>
  );
}
