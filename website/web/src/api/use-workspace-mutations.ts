/** 待办、天气、屏幕布局与设备设置的写入 hooks。 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { toast, useUiStore } from '@/store/ui-store';
import { queryKeys } from './query-keys';
import type {
  DeviceSettingsPayload,
  DisplayLayout,
  Todo,
  TodoPayload,
  WeatherSettings,
} from '@/types';

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

function reportError(context: string, error: unknown): void {
  toast.error(context, { description: describeError(error) });
}

/* ------------------------------ 待办 ------------------------------ */

export function useCreateTodo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: TodoPayload) => api.createTodo(payload),
    onSuccess: (todo) => {
      toast.success('待办已添加', todo.title);
      void client.invalidateQueries({ queryKey: ['todos'] });
    },
    onError: (error) => reportError('添加待办失败', error),
  });
}

export function useUpdateTodo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Partial<TodoPayload> & { done?: boolean } }) =>
      api.updateTodo(id, payload),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['todos'] });
    },
    onError: (error) => reportError('更新待办失败', error),
  });
}

export function useToggleTodo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, done }: { id: number; done: boolean }) => api.updateTodo(id, { done }),
    onMutate: async ({ id, done }) => {
      await client.cancelQueries({ queryKey: ['todos'] });
      const snapshot = client.getQueriesData<{ items: Todo[] }>({ queryKey: ['todos'] });
      for (const [key, value] of snapshot) {
        if (!value) continue;
        client.setQueryData(key, {
          ...value,
          items: value.items.map((item) =>
            item.id === id
              ? { ...item, done, completedAt: done ? new Date().toISOString() : null }
              : item,
          ),
        });
      }
      return { snapshot };
    },
    onError: (error, _variables, context) => {
      for (const [key, value] of context?.snapshot ?? []) client.setQueryData(key, value);
      reportError('更新待办失败', error);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['todos'] });
    },
  });
}

export function useDeleteTodo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteTodo(id),
    onSuccess: () => {
      toast.success('待办已删除');
      void client.invalidateQueries({ queryKey: ['todos'] });
    },
    onError: (error) => reportError('删除待办失败', error),
  });
}

export function useReorderTodos() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => api.reorderTodos(ids),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['todos'] });
    },
    onError: (error) => reportError('调整顺序失败', error),
  });
}

/* ------------------------------ 天气 ------------------------------ */

export function useRefreshWeather() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshWeather(),
    onSuccess: (snapshot) => {
      client.setQueryData(queryKeys.weather, snapshot);
      toast.success('天气已更新', snapshot.message ?? `${snapshot.city} · ${snapshot.current.condition}`);
    },
    onError: (error) => reportError('刷新天气失败', error),
  });
}

export function useUpdateWeatherSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<WeatherSettings>) => api.updateWeatherSettings(payload),
    onSuccess: (settings) => {
      toast.success('天气位置已保存', `${settings.city} · ${settings.latitude}, ${settings.longitude}`);
      void client.invalidateQueries({ queryKey: ['weather'] });
    },
    onError: (error) => reportError('保存天气设置失败', error),
  });
}

/* ------------------------------ 屏幕布局 ------------------------------ */

export function useUpdateDisplay() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: { layout?: DisplayLayout; refreshMinutes?: number }) =>
      api.updateDisplay(payload),
    onSuccess: () => {
      toast.success('屏幕布局已生效', '设备下次拉取时会拿到新布局');
      void client.invalidateQueries({ queryKey: ['display'] });
      void client.invalidateQueries({ queryKey: ['device'] });
    },
    onError: (error) => reportError('保存屏幕布局失败', error),
  });
}

/* ------------------------------ 设备 ------------------------------ */

export function useUpdateDeviceSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: DeviceSettingsPayload) => api.updateDeviceSettings(payload),
    onSuccess: (status) => {
      toast.success('设备设置已保存', status.name);
      void client.invalidateQueries({ queryKey: ['device'] });
      void client.invalidateQueries({ queryKey: ['display'] });
    },
    onError: (error) => reportError('保存设备设置失败', error),
  });
}

export function useRotateDeviceToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.rotateDeviceToken(),
    onSuccess: ({ token }) => {
      toast.success('设备令牌已轮换', '旧令牌立即失效，请同步更新设备端配置');
      client.setQueryData(queryKeys.deviceToken, { token });
      void client.invalidateQueries({ queryKey: ['device'] });
    },
    onError: (error) => reportError('轮换设备令牌失败', error),
  });
}

/* ------------------------------ 工具 ------------------------------ */

/** 复制文本并给出轻提示；不支持 Clipboard API 时退回 execCommand。 */
export async function copyText(text: string, label = '已复制到剪贴板'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    useUiStore.getState().pushToast({ tone: 'success', message: label });
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    document.body.removeChild(area);
    useUiStore.getState().pushToast({ tone: 'success', message: label });
  }
}
