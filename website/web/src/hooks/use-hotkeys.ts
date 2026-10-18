import { useEffect, useRef } from 'react';
import type { CalendarView } from '@/types';

export interface HotkeyHandlers {
  onToday?: () => void;
  onSelectView?: (view: CalendarView) => void;
  onAgenda?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onCreate?: () => void;
  onFocusSearch?: () => void;
  onEscape?: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable === true
  );
}

/**
 * 全局快捷键。刻意避开与浏览器/输入法冲突的组合，且在有输入焦点时全部让位。
 *
 * T 今天 / M 月 / W 周 / D 日 / A 列表 / ← → 前后翻页 / N 新建 / / 搜索 / Esc 收起
 */
export function useHotkeys(handlers: HotkeyHandlers, enabled = true): void {
  // 用 ref 持有最新回调，避免每次渲染都重新绑定 window 监听
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      const current = handlersRef.current;
      if (event.defaultPrevented) return;
      // 保留浏览器与系统的组合键（复制、刷新、输入法切换等）
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'Escape') {
        current.onEscape?.();
        return;
      }
      if (isTypingTarget(event.target)) return;

      switch (event.key) {
        case '/': {
          event.preventDefault();
          current.onFocusSearch?.();
          return;
        }
        case 'ArrowLeft': {
          event.preventDefault();
          current.onPrev?.();
          return;
        }
        case 'ArrowRight': {
          event.preventDefault();
          current.onNext?.();
          return;
        }
        default:
          break;
      }

      switch (event.key.toLowerCase()) {
        case 't':
          current.onToday?.();
          break;
        case 'm':
          current.onSelectView?.('month');
          break;
        case 'w':
          current.onSelectView?.('week');
          break;
        case 'd':
          current.onSelectView?.('day');
          break;
        case 'a':
          current.onAgenda?.();
          break;
        case 'n':
          event.preventDefault();
          current.onCreate?.();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
