/** 外壳相关的共享 hooks：顶栏属性与全局快捷键。 */

import { useCallback, useMemo, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useHealth } from '@/api/use-calendar-data';
import { toDateKey } from '@/lib/date';
import { activeFilterCount, useUiStore } from '@/store/ui-store';
import type { TopBarProps } from '@/components/layout/TopBar';
import { useCalendarParams } from './use-calendar-params';
import { useHotkeys } from './use-hotkeys';
import type { CalendarView } from '@/types';

export type ShellTopBarProps = TopBarProps;

export interface ShellTopBarOptions {
  /** 非日历页不显示筛选按钮 */
  showFilters?: boolean;
}

export function useShellTopBar(options: ShellTopBarOptions = {}): ShellTopBarProps {
  const health = useHealth();
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const filters = useUiStore((state) => state.filters);
  const setFiltersPanelOpen = useUiStore((state) => state.setFiltersPanelOpen);

  const openFilters = useCallback(() => setFiltersPanelOpen(true), [setFiltersPanelOpen]);
  const showFilters = options.showFilters ?? true;

  return useMemo(
    () => ({
      isOffline: health.isError,
      theme,
      onChangeTheme: setTheme,
      onOpenFilters: openFilters,
      activeFilterCount: activeFilterCount(filters),
      showFilters,
    }),
    [health.isError, theme, setTheme, openFilters, filters, showFilters],
  );
}

export interface AppHotkeyOptions {
  searchRef?: RefObject<HTMLInputElement>;
  onCreate: () => void;
  onEscape?: () => void;
}

/**
 * 全局快捷键绑定。放在这里而不是 App 根部，
 * 是因为「上一页 / 下一页」的步长取决于当前视图。
 */
export function useAppHotkeys({ searchRef, onCreate, onEscape }: AppHotkeyOptions): void {
  const navigate = useNavigate();
  const { anchor, goPrev, goNext, goToday } = useCalendarParams();

  const goToView = useCallback(
    (view: CalendarView) => {
      navigate(`/calendar/${view}?d=${toDateKey(anchor)}`);
    },
    [anchor, navigate],
  );

  useHotkeys({
    onToday: goToday,
    onPrev: goPrev,
    onNext: goNext,
    onSelectView: goToView,
    onAgenda: () => navigate(`/agenda?d=${toDateKey(anchor)}`),
    onCreate,
    onFocusSearch: () => searchRef?.current?.focus(),
    onEscape,
  });
}
