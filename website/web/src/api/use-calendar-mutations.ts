/** 服务端数据的写入 hooks。所有写操作成功后统一失效相关缓存，避免出现陈旧视图。 */

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { toast } from '@/store/ui-store';
import { queryKeys } from './query-keys';
import type {
  CategoryPayload,
  EventPayload,
  MoveOccurrencePayload,
  OccurrenceOverridePayload,
} from '@/types';
import type { OccurrencesResult } from './use-calendar-data';

function invalidateCalendar(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: ['occurrences'] });
  void client.invalidateQueries({ queryKey: ['summary'] });
  void client.invalidateQueries({ queryKey: ['events'] });
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isNetworkError) return error.message;
    if (error.isValidationError) return error.message;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

function reportError(context: string, error: unknown): void {
  toast.error(context, { description: describeError(error) });
}

/* ------------------------------ 日程主体 ------------------------------ */

export function useCreateEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: EventPayload) => api.createEvent(payload),
    onSuccess: (event) => {
      toast.success('日程已创建', event.title);
      invalidateCalendar(client);
    },
    onError: (error) => reportError('创建日程失败', error),
  });
}

export function useUpdateEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Partial<EventPayload> }) =>
      api.updateEvent(id, payload),
    onSuccess: (event) => {
      toast.success('日程已更新', event.title);
      invalidateCalendar(client);
    },
    onError: (error) => reportError('更新日程失败', error),
  });
}

export function useDeleteEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteEvent(id),
    onSuccess: () => {
      toast.success('日程已删除');
      invalidateCalendar(client);
    },
    onError: (error) => reportError('删除日程失败', error),
  });
}

/* ------------------------------ 实例级 ------------------------------ */

interface MoveVariables {
  eventId: number;
  payload: MoveOccurrencePayload;
}

export function useMoveOccurrence() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, payload }: MoveVariables) => api.moveOccurrence(eventId, payload),
    // 「仅此一次」是最常见操作，先就地更新缓存，拖拽松手后视觉立即到位
    onMutate: async ({ eventId, payload }: MoveVariables) => {
      if ((payload.scope ?? 'single') !== 'single') return { snapshots: [] };
      await client.cancelQueries({ queryKey: ['occurrences'] });
      const snapshots = client.getQueriesData<OccurrencesResult>({ queryKey: ['occurrences'] });

      client.setQueriesData<OccurrencesResult>({ queryKey: ['occurrences'] }, (data) => {
        if (!data) return data;
        let touched = false;
        const items = data.items.map((occurrence) => {
          if (occurrence.eventId !== eventId || occurrence.occurrenceKey !== payload.occurrenceKey) {
            return occurrence;
          }
          touched = true;
          return {
            ...occurrence,
            startAt: payload.startAt,
            endAt: payload.endAt,
            allDay: payload.allDay ?? occurrence.allDay,
            isModified: true,
          };
        });
        return touched ? { ...data, items } : data;
      });

      return { snapshots };
    },
    onError: (error, _variables, context) => {
      for (const [key, data] of context?.snapshots ?? []) client.setQueryData(key, data);
      reportError('调整时间失败', error);
    },
    onSettled: () => invalidateCalendar(client),
  });
}

export function useCancelOccurrence() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      eventId,
      occurrenceKey,
      scope,
    }: {
      eventId: number;
      occurrenceKey: string;
      scope?: 'single' | 'future';
    }) => api.cancelOccurrence(eventId, { occurrenceKey, scope }),
    onSuccess: () => {
      toast.success('已取消该日程');
      invalidateCalendar(client);
    },
    onError: (error) => reportError('取消失败', error),
  });
}

export function useOverrideOccurrence() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      eventId,
      payload,
    }: {
      eventId: number;
      payload: OccurrenceOverridePayload;
    }) => api.overrideOccurrence(eventId, payload),
    onSuccess: () => {
      toast.success('已更新本次日程');
      invalidateCalendar(client);
    },
    onError: (error) => reportError('更新本次日程失败', error),
  });
}

export function useResetOverride() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, occurrenceKey }: { eventId: number; occurrenceKey: string }) =>
      api.resetOverride(eventId, occurrenceKey),
    onSuccess: () => {
      toast.success('已恢复为序列默认值');
      invalidateCalendar(client);
    },
    onError: (error) => reportError('恢复失败', error),
  });
}

/* ------------------------------ 分类 ------------------------------ */

export function useCreateCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: CategoryPayload) => api.createCategory(payload),
    onSuccess: (category) => {
      toast.success('分类已创建', category.name);
      void client.invalidateQueries({ queryKey: queryKeys.categories });
      invalidateCalendar(client);
    },
    onError: (error) => reportError('创建分类失败', error),
  });
}

export function useUpdateCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Partial<CategoryPayload> }) =>
      api.updateCategory(id, payload),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.categories });
      invalidateCalendar(client);
    },
    onError: (error) => reportError('更新分类失败', error),
  });
}

export function useDeleteCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteCategory(id),
    onSuccess: (result) => {
      toast.success(
        '分类已删除',
        result.detachedEventCount > 0
          ? `${result.detachedEventCount} 条日程已变为「未分类」`
          : undefined,
      );
      void client.invalidateQueries({ queryKey: queryKeys.categories });
      invalidateCalendar(client);
    },
    onError: (error) => reportError('删除分类失败', error),
  });
}
