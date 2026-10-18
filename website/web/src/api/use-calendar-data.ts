/** 服务端数据的读取 hooks（React Query）。 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, filtersToQuery } from '@/lib/api';
import { queryKeys, occurrenceQueryKey, type OccurrenceQueryParams } from './query-keys';
import type {
  CalendarEvent,
  Category,
  HealthInfo,
  Occurrence,
  OccurrenceMeta,
  StatsSummary,
} from '@/types';

export function useCategories() {
  return useQuery<Category[]>({
    queryKey: queryKeys.categories,
    queryFn: ({ signal }) => api.listCategories(signal),
    staleTime: 60_000,
  });
}

export function useHealth() {
  return useQuery<HealthInfo>({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => api.health(signal),
    retry: 1,
    staleTime: 30_000,
  });
}

export interface OccurrencesResult {
  items: Occurrence[];
  meta?: OccurrenceMeta;
}

export function useOccurrences(params: OccurrenceQueryParams, enabled = true) {
  return useQuery<OccurrencesResult>({
    queryKey: occurrenceQueryKey(params),
    queryFn: async ({ signal }): Promise<OccurrencesResult> => {
      const response = await api.listOccurrences(
        {
          from: params.from,
          to: params.to,
          limit: params.limit ?? 1200,
          ...filtersToQuery(params.filters),
        },
        signal,
      );
      return { items: response.data ?? [], meta: response.meta };
    },
    enabled,
    // 切换月份/周时保留上一次结果，避免网格闪空
    placeholderData: keepPreviousData,
    staleTime: 20_000,
  });
}

export function useSummary(params: { from: string; to: string }, enabled = true) {
  return useQuery<StatsSummary>({
    queryKey: queryKeys.summary({ from: params.from, to: params.to }),
    queryFn: ({ signal }) => api.summary({ from: params.from, to: params.to }, signal),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 20_000,
  });
}

/** 读取日程主记录（未展开）。编辑重复日程的「整个序列」时需要它来计算时间平移量。 */
export function useEventMaster(id: number | null, enabled = true) {
  return useQuery<CalendarEvent>({
    queryKey: queryKeys.events({ detail: id }),
    queryFn: () => api.getEvent(id as number),
    enabled: enabled && id !== null,
    staleTime: 30_000,
  });
}
