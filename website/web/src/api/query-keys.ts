import type { Filters } from '@/types';

/** React Query 缓存键集中定义，避免散落的字符串数组导致失效不干净。 */
export const queryKeys = {
  health: ['health'] as const,
  categories: ['categories'] as const,
  events: (params: Record<string, unknown>) => ['events', params] as const,
  occurrences: (params: Record<string, unknown>) => ['occurrences', params] as const,
  summary: (params: Record<string, unknown>) => ['summary', params] as const,
  todos: (params: Record<string, unknown>) => ['todos', params] as const,
  weather: ['weather'] as const,
  weatherSettings: ['weather', 'settings'] as const,
  weatherSearch: (query: string) => ['weather', 'search', query] as const,
  display: ['display'] as const,
  screen: ['display', 'screen'] as const,
  device: ['device'] as const,
  deviceToken: ['device', 'token'] as const,
};

export interface RangeParams {
  from: string;
  to: string;
}

export interface OccurrenceQueryParams extends RangeParams {
  filters: Filters;
  limit?: number;
}

export function occurrenceQueryKey(params: OccurrenceQueryParams): readonly unknown[] {
  return queryKeys.occurrences({
    from: params.from,
    to: params.to,
    limit: params.limit ?? 1200,
    q: params.filters.q,
    categoryIds: params.filters.categoryIds,
    priorities: params.filters.priorities,
    statuses: params.filters.statuses,
    tags: params.filters.tags,
    includeCancelled: params.filters.includeCancelled,
  });
}
