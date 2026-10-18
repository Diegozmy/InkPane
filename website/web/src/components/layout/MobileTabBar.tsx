/** 移动端底部标签栏：只放最高频的入口，其余走顶部导航与页面内链接。 */

import type { ReactElement } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/ui/icon';

const ITEMS: readonly { to: string; label: string; icon: IconName; match: string }[] = [
  { to: '/today', label: '总览', icon: 'house', match: '/today' },
  { to: '/calendar/month', label: '日历', icon: 'calendar-dots', match: '/calendar' },
  { to: '/todos', label: '待办', icon: 'check-square', match: '/todos' },
  { to: '/weather', label: '天气', icon: 'cloud-sun', match: '/weather' },
  { to: '/device', label: '设备', icon: 'device', match: '/device' },
  { to: '/settings', label: '设置', icon: 'settings', match: '/settings' },
];

export function MobileTabBar(): ReactElement {
  const { pathname } = useLocation();

  return (
    <nav className="tabbar" aria-label="主导航">
      {ITEMS.map((item) => {
        const active =
          item.match === '/calendar' ? pathname.startsWith('/calendar') : pathname === item.to;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={cn('tabbar__item', active && 'is-active')}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
