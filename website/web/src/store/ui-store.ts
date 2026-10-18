/**
 * 全局 UI 状态（Zustand）。
 *
 * 只放“跨组件共享且非服务端数据”的内容：筛选条件、侧栏开合、编辑弹窗、
 * 轻提示队列与主题偏好。服务端数据一律由 React Query 管理，避免两套缓存打架。
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { EMPTY_FILTERS, type Filters, type Occurrence } from '@/types';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ToastTone = 'info' | 'success' | 'error';

export interface ToastItem {
  id: string;
  tone: ToastTone;
  message: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  durationMs: number;
}

export interface EditorDefaults {
  startAt: string;
  endAt: string;
  allDay: boolean;
}

export type EditorState =
  | { mode: 'create'; defaults: EditorDefaults }
  | { mode: 'edit'; occurrence: Occurrence };

interface UiState {
  filters: Filters;
  patchFilters: (patch: Partial<Filters>) => void;
  toggleFilterValue: <K extends 'categoryIds' | 'priorities' | 'statuses' | 'tags'>(
    key: K,
    value: Filters[K][number],
  ) => void;
  resetFilters: () => void;

  detailsOccurrence: Occurrence | null;
  setDetailsOccurrence: (occurrence: Occurrence | null) => void;

  editor: EditorState | null;
  openCreateEditor: (defaults: EditorDefaults) => void;
  openEditEditor: (occurrence: Occurrence) => void;
  closeEditor: () => void;

  toasts: ToastItem[];
  pushToast: (toast: Omit<ToastItem, 'id' | 'durationMs'> & { durationMs?: number }) => string;
  dismissToast: (id: string) => void;

  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  /** useTheme 解析后的实际主题，供需要按主题切换配色的组件读取 */
  resolvedTheme: 'light' | 'dark';
  setResolvedTheme: (mode: 'light' | 'dark') => void;

  remindersEnabled: boolean;
  setRemindersEnabled: (enabled: boolean) => void;

  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;

  filtersPanelOpen: boolean;
  setFiltersPanelOpen: (open: boolean) => void;
}

let toastSeed = 0;

function nextToastId(): string {
  toastSeed += 1;
  return `toast-${Date.now()}-${toastSeed}`;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      filters: EMPTY_FILTERS,
      patchFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
      toggleFilterValue: (key, value) =>
        set((state) => {
          const current = state.filters[key] as (string | number)[];
          const exists = current.includes(value as never);
          const next = exists
            ? current.filter((item) => item !== value)
            : [...current, value as never];
          return { filters: { ...state.filters, [key]: next } };
        }),
      resetFilters: () => set({ filters: EMPTY_FILTERS }),

      detailsOccurrence: null,
      setDetailsOccurrence: (occurrence) => set({ detailsOccurrence: occurrence }),

      editor: null,
      openCreateEditor: (defaults) => set({ editor: { mode: 'create', defaults } }),
      openEditEditor: (occurrence) => set({ editor: { mode: 'edit', occurrence } }),
      closeEditor: () => set({ editor: null }),

      toasts: [],
      pushToast: (input) => {
        const id = nextToastId();
        const item: ToastItem = { durationMs: 4200, ...input, id };
        set((state) => ({ toasts: [...state.toasts, item].slice(-4) }));
        return id;
      },
      dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),

      theme: 'system',
      setTheme: (mode) => set({ theme: mode }),
      resolvedTheme: 'light',
      setResolvedTheme: (mode) => {
        if (get().resolvedTheme !== mode) set({ resolvedTheme: mode });
      },

      remindersEnabled: true,
      setRemindersEnabled: (enabled) => set({ remindersEnabled: enabled }),

      sidebarOpen: false,
      setSidebarOpen: (open) => set({ sidebarOpen: open }),

      filtersPanelOpen: false,
      setFiltersPanelOpen: (open) => set({ filtersPanelOpen: open }),
    }),
    {
      name: 'inkpane.ui',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        filters: state.filters,
        theme: state.theme,
        remindersEnabled: state.remindersEnabled,
      }),
      version: 1,
    },
  ),
);

/** 供非组件环境（如 React Query 回调）使用的轻提示入口。 */
export const toast = {
  info: (message: string, description?: string): string =>
    useUiStore.getState().pushToast({ tone: 'info', message, description }),
  success: (message: string, description?: string): string =>
    useUiStore.getState().pushToast({ tone: 'success', message, description }),
  error: (
    message: string,
    options?: { description?: string; action?: { label: string; onClick: () => void } },
  ): string =>
    useUiStore.getState().pushToast({
      tone: 'error',
      message,
      description: options?.description,
      action: options?.action,
      durationMs: 6000,
    }),
};

export function activeFilterCount(filters: Filters): number {
  return (
    (filters.q.trim() ? 1 : 0) +
    filters.categoryIds.length +
    filters.priorities.length +
    filters.statuses.length +
    filters.tags.length +
    (filters.includeCancelled ? 1 : 0)
  );
}
