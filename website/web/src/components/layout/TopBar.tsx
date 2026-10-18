/** 顶栏：品牌、主导航、连接状态与主题切换。 */

import type { ReactElement } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/ui/icon';
import { IconButton, Menu } from '@/components/ui';
import type { ThemeMode } from '@/store/ui-store';
import type { HealthInfo } from '@/types';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  match: string;
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/today', label: '总览', icon: 'house', match: '/today' },
  { to: '/calendar/month', label: '日历', icon: 'calendar-dots', match: '/calendar' },
  { to: '/todos', label: '待办', icon: 'check-square', match: '/todos' },
  { to: '/weather', label: '天气', icon: 'cloud-sun', match: '/weather' },
  { to: '/device', label: '设备', icon: 'device', match: '/device' },
  { to: '/courses', label: '课程', icon: 'book', match: '/courses' },
  { to: '/settings', label: '设置', icon: 'settings', match: '/settings' },
];

const THEME_LABELS: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

export interface TopBarProps {
  health: HealthInfo | undefined;
  isOffline: boolean;
  theme: ThemeMode;
  onChangeTheme: (mode: ThemeMode) => void;
  /** 未提供时不渲染侧栏开关（页面没有侧栏时） */
  onOpenSidebar?: () => void;
  /** 未提供时不渲染筛选按钮（非日历页） */
  onOpenFilters?: () => void;
  activeFilterCount?: number;
  showFilters?: boolean;
}

export function TopBar({
  health,
  isOffline,
  theme,
  onChangeTheme,
  onOpenSidebar,
  onOpenFilters,
  activeFilterCount = 0,
  showFilters = true,
}: TopBarProps): ReactElement {
  const { pathname } = useLocation();

  return (
    <header className="topbar">
      {onOpenSidebar && (
        <button
          type="button"
          className="btn btn--icon btn--ghost topbar__menu"
          aria-label="打开侧栏"
          onClick={onOpenSidebar}
        >
          <Icon name="sidebar" size={18} />
        </button>
      )}

      <NavLink to="/today" className="brand">
        <span className="brand__mark" aria-hidden="true">
          <Icon name="grid" size={18} weight="fill" />
        </span>
        <span className="brand__text">
          <span className="brand__name">InkPane 墨窗</span>
          <span className="brand__sub">桌面信息窗 · 控制台</span>
        </span>
      </NavLink>

      <nav className="topbar__nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const active =
            item.match === '/calendar' ? pathname.startsWith('/calendar') : pathname === item.to;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={cn('topbar__link', active && 'is-active')}
            >
              <Icon name={item.icon} size={15} />
              <span className="topbar__link-text">{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="topbar__spacer" />

      <div className="topbar__actions">
        {showFilters && onOpenFilters && (
          <button
            type="button"
            className="btn btn--icon btn--ghost topbar__filter"
            aria-label={activeFilterCount > 0 ? `筛选（已启用 ${activeFilterCount} 项）` : '筛选'}
            onClick={onOpenFilters}
          >
            <Icon name="filter" size={18} />
            {activeFilterCount > 0 && <span className="topbar__badge numeric">{activeFilterCount}</span>}
          </button>
        )}

        <span
          className={cn('connection-dot', isOffline ? 'connection-dot--offline' : 'connection-dot--online')}
          title={isOffline ? '无法连接后端服务' : `后端正常 · 共 ${health?.eventCount ?? 0} 条日程`}
        >
          <Icon name={isOffline ? 'offline' : 'online'} size={13} />
          <span className="connection-dot__text">{isOffline ? '未连接' : '已连接'}</span>
        </span>

        <Menu
          label="切换主题"
          items={[
            { key: 'light', label: '浅色', icon: 'sun', onSelect: () => onChangeTheme('light') },
            { key: 'dark', label: '深色', icon: 'moon', onSelect: () => onChangeTheme('dark') },
            {
              key: 'system',
              label: '跟随系统',
              icon: 'desktop',
              onSelect: () => onChangeTheme('system'),
            },
          ]}
          trigger={({ toggle, ref }) => (
            <IconButton
              ref={ref}
              icon={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'desktop'}
              label={`主题：${THEME_LABELS[theme]}`}
              onClick={toggle}
            />
          )}
        />
      </div>
    </header>
  );
}
