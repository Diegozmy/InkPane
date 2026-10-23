/** 待办、天气、屏幕布局与设备状态的读取 hooks（React Query）。 */

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './query-keys';
import type {
  DeviceScreenPayload,
  DisplayConfig,
  Todo,
  TodoMeta,
  WeatherSearchResult,
  WeatherSettings,
  WeatherSnapshot,
} from '@/types';

/* ------------------------------ 待办 ------------------------------ */

export interface TodoQueryParams {
  done?: boolean;
  due?: 'today' | 'week';
  limit?: number;
  offset?: number;
}

export interface TodosResult {
  items: Todo[];
  meta?: TodoMeta;
}

export function useTodos(params: TodoQueryParams = {}) {
  return useQuery<TodosResult>({
    queryKey: queryKeys.todos({
      done: params.done,
      due: params.due,
      limit: params.limit ?? 200,
      offset: params.offset ?? 0,
    }),
    queryFn: async ({ signal }): Promise<TodosResult> => {
      const response = await api.listTodos(
        {
          done: params.done,
          due: params.due,
          limit: params.limit ?? 200,
          offset: params.offset ?? 0,
        },
        signal,
      );
      return { items: response.data ?? [], meta: response.meta };
    },
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

/* ------------------------------ 天气 ------------------------------ */

export function useWeather(enabled = true) {
  return useQuery<WeatherSnapshot>({
    queryKey: queryKeys.weather,
    queryFn: ({ signal }) => api.weather(signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useWeatherSettings() {
  return useQuery<WeatherSettings>({
    queryKey: queryKeys.weatherSettings,
    queryFn: ({ signal }) => api.weatherSettings(signal),
    staleTime: 60_000,
  });
}

export function useWeatherSearch(query: string) {
  const keyword = query.trim();
  return useQuery<{ results: WeatherSearchResult[]; warning?: string }>({
    queryKey: queryKeys.weatherSearch(keyword),
    queryFn: async ({ signal }) => {
      const response = await api.searchWeather(keyword, signal);
      return {
        results: response.data?.results ?? [],
        warning: (response.meta as { warning?: string } | undefined)?.warning,
      };
    },
    enabled: keyword.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: 0,
  });
}

/* ------------------------------ 屏幕布局 ------------------------------ */

export function useDisplayConfig() {
  return useQuery<DisplayConfig>({
    queryKey: queryKeys.display,
    queryFn: ({ signal }) => api.displayConfig(signal),
    staleTime: 15_000,
  });
}

export function useScreenPreview(enabled = true) {
  return useQuery<DeviceScreenPayload>({
    queryKey: queryKeys.screen,
    queryFn: ({ signal }) => api.displayScreen(signal),
    enabled,
    staleTime: 20_000,
    refetchInterval: 60_000,
  });
}

/* ------------------------------ 设备 ------------------------------ */
