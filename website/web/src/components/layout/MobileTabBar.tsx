/** 移动端底部标签栏。 */

import type { ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/ui/icon';

const ITEMS: readonly { to: string; label: string; icon: IconName; match: string }[] = [
  { to: '/calendar/month', label: '月', icon: 'calendar-dots', match: '/calendar/month' },
  { to: '/calendar/week', label: '周', icon: 'rows', match: '/calendar/week' },
  { to: '/calendar/day', label: '日', icon: 'calendar-blank', match: '/calendar/day' },
  { to: '/agenda', label: '列表', icon: 'list-bullets', match: '/agenda' },
];

export function MobileTabBar(): ReactElement {
  return (
    <nav className="tabbar" aria-label="视图切换">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => cn('tabbar__item', isActive && 'is-active')}
        >
          <Icon name={item.icon} size={20} />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
