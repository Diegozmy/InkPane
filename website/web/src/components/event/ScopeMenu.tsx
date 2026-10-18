/** 拖拽重复日程松手后弹出的范围选择菜单。 */

import { useEffect, useRef, type ReactElement } from 'react';
import { Icon, type IconName } from '@/components/ui/icon';
import type { MoveScope } from '@/types';

export interface ScopeMenuProps {
  /** 视口坐标（通常取拖拽落点） */
  position: { x: number; y: number };
  title: string;
  onChoose: (scope: MoveScope) => void;
  onCancel: () => void;
}

const OPTIONS: readonly { scope: MoveScope; label: string; hint: string; icon: IconName }[] = [
  { scope: 'single', label: '仅此一次', hint: '其他重复时间不变', icon: 'calendar-check' },
  { scope: 'future', label: '此后所有', hint: '本次及之后一起改', icon: 'caret-right' },
  { scope: 'all', label: '整个序列', hint: '整条重复序列平移', icon: 'repeat' },
];

const MENU_WIDTH = 232;
const MENU_HEIGHT = 176;

export function ScopeMenu({ position, title, onChoose, onCancel }: ScopeMenuProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onCancel();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    // 延迟一帧绑定，避免捕获到触发本次菜单的那次点击
    const timer = window.setTimeout(
      () => document.addEventListener('mousedown', onPointerDown),
      0,
    );
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onCancel);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onCancel);
    };
  }, [onCancel]);

  const left = Math.max(8, Math.min(position.x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(position.y, window.innerHeight - MENU_HEIGHT - 8));

  return (
    <div
      className="scope-menu"
      ref={ref}
      role="menu"
      aria-label="选择修改范围"
      style={{ left, top }}
    >
      <p className="scope-menu__title truncate">这是重复日程：{title}</p>
      {OPTIONS.map((option) => (
        <button
          key={option.scope}
          type="button"
          role="menuitem"
          className="menu__item"
          onClick={() => onChoose(option.scope)}
        >
          <Icon name={option.icon} size={15} />
          <span className="grow">
            <span style={{ display: 'block' }}>{option.label}</span>
            <span className="faint" style={{ fontSize: 'var(--text-xs)' }}>
              {option.hint}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
