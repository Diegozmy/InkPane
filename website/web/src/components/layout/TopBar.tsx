/** 顶栏：品牌、主导航、连接状态与主题切换。 */

import type { ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/ui/icon';
import { IconButton, Menu } from '@/components/ui';
import type { ThemeMode } from '@/store/ui-store';
import type { HealthInfo } from '@/types';

const NAV_ITEMS = [
  { to: '/calendar/month', label: '日历', icon: 'calendar-dots' as const, match: '/calendar' },
  { to: '/agenda', label: '列表', icon: 'list-bullets' as const, match: '/agenda' },
  { to: '/courses', label: '课程', icon: 'book' as const, match: '/courses' },
  { to: '/settings', label: '设置', icon: 'settings' as const, match: '/settings' },
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
  onOpenSidebar: () => void;
  onOpenFilters: () => void;
  activeFilterCount: number;
}

export function TopBar({
  health,
  isOffline,
  theme,
  onChangeTheme,
  onOpenSidebar,
  onOpenFilters,
  activeFilterCount,
}: TopBarProps): ReactElement {
  return (
    <header className="topbar">
      <button
        type="button"
        className="btn btn--icon btn--ghost topbar__menu"
        aria-label="打开侧栏"
        onClick={onOpenSidebar}
      >
        <Icon name="sidebar" size={18} />
      </button>

      <NavLink to="/calendar/month" className="brand">
        <span className="brand__mark" aria-hidden="true">
          <Icon name="calendar-dots" size={18} weight="fill" />
        </span>
        <span className="brand__text">
          <span className="brand__name">InkPane 日程</span>
          <span className="brand__sub">月 · 周 · 日 · 列表</span>
        </span>
      </NavLink>

      <nav className="topbar__nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => cn('topbar__link', isActive && 'is-active')}
          >
            <Icon name={item.icon} size={15} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="topbar__spacer" />

      <div className="topbar__actions">
        <button
          type="button"
          className="btn btn--icon btn--ghost topbar__filter"
          aria-label={activeFilterCount > 0 ? `筛选（已启用 ${activeFilterCount} 项）` : '筛选'}
          onClick={onOpenFilters}
        >
          <Icon name="filter" size={18} />
        </button>

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
