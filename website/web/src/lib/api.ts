/** 类型安全的 API 客户端。所有网络错误统一收敛为 ApiError。 */

import type {
  AuthSession,
  AuthUser,
  CalendarEvent,
  Category,
  CategoryPayload,
  CoursePreview,
  CourseSyncSettings,
  CourseSyncStatus,
  CourseImportResult,
  CreatedDevice,
  CredentialsSummary,
  DeviceScreenPayload,
  DeviceSummary,
  DisplayConfig,
  DisplayLayout,
  EventPayload,
  Filters,
  HealthInfo,
  MoveOccurrencePayload,
  Occurrence,
  OccurrenceMeta,
  OccurrenceOverridePayload,
  PageMeta,
  ReminderItem,
  SetupStatus,
  StatsSummary,
  SyncNowResult,
  Todo,
  TodoMeta,
  TodoPayload,
  UserRole,
  UserSummary,
  WeatherSearchResult,
  WeatherSettings,
  WeatherSnapshot,
} from '@/types';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/$/, '');

/**
 * 401 全局事件只用来处理「登录态失效」。
 * 登录失败本身也是 401，初始化接口需要拿到原始错误，二者都不应触发退出跳转。
 */
const UNAUTHORIZED_EVENT_SKIP_PREFIXES = ['/auth/login', '/setup'] as const;

function shouldBroadcastUnauthorized(path: string): boolean {
  return !UNAUTHORIZED_EVENT_SKIP_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(
    message: string,
    status: number,
    code = 'HTTP_ERROR',
    details?: unknown,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId ?? null;
  }

  /** 网络不可达（后端未启动）时给出可操作的提示。 */
  get isNetworkError(): boolean {
    return this.status === 0;
  }

  get isValidationError(): boolean {
    return this.code === 'VALIDATION_FAILED';
  }
}

export type QueryValue = string | number | boolean | undefined | null | (string | number)[];

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        search.set(key, value.join(','));
      } else if (typeof value === 'boolean') {
        search.set(key, value ? 'true' : 'false');
      } else {
        const text = String(value);
        if (text.length === 0) continue;
        search.set(key, text);
      }
    }
  }
  const queryString = search.toString();
  return `${API_BASE}${path}${queryString ? `?${queryString}` : ''}`;
}

interface Envelope<T> {
  data: T;
  meta?: unknown;
}

async function requestEnvelope<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const url = buildUrl(path, options.query);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
      credentials: 'include',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      '无法连接后端服务，请确认 API 服务已启动（默认 http://127.0.0.1:4000）',
      0,
      'NETWORK_ERROR',
    );
  }

  if (response.status === 204) return { data: undefined as T };

  const text = await response.text();
  let payload: unknown = undefined;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError('服务端返回了非 JSON 响应', response.status, 'INVALID_RESPONSE');
    }
  }

  if (!response.ok) {
    const errorBody = (
      payload as {
        error?: { message?: string; code?: string; details?: unknown; requestId?: string };
      }
    )?.error;
    if (response.status === 401 && typeof window !== 'undefined' && shouldBroadcastUnauthorized(path)) {
      window.dispatchEvent(new Event('inkpane:unauthorized'));
    }
    throw new ApiError(
      errorBody?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      errorBody?.code ?? 'HTTP_ERROR',
      errorBody?.details,
      errorBody?.requestId,
    );
  }

  const envelope = payload as Envelope<T> | undefined;
  return { data: (envelope?.data ?? (undefined as T)), meta: envelope?.meta };
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { data } = await requestEnvelope<T>(path, options);
  return data;
}

/** 把筛选状态转换成查询参数。 */
export function filtersToQuery(filters: Filters): Record<string, QueryValue> {
  return {
    q: filters.q.trim() || undefined,
    categoryId: filters.categoryIds,
    priority: filters.priorities,
    status: filters.statuses,
    tag: filters.tags,
    includeCancelled: filters.includeCancelled ? true : undefined,
  };
}

export const api = {
  health: (signal?: AbortSignal) => request<HealthInfo>('/health', { signal }),

  /* ---------------- 账户 ---------------- */
  setupStatus: (signal?: AbortSignal) => request<SetupStatus>('/setup/status', { signal }),
  setup: (payload: {
    username: string;
    password: string;
    displayName?: string;
    timezone?: string;
    /** 服务端开启初始化码校验时必填 */
    code?: string;
  }) => request<AuthSession>('/setup', { method: 'POST', body: payload }),
  login: (payload: { username: string; password: string }) =>
    request<AuthSession>('/auth/login', { method: 'POST', body: payload }),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST', body: {} }),
  me: (signal?: AbortSignal) => request<AuthSession>('/auth/me', { signal }),
  updateProfile: (payload: { displayName: string }) =>
    request<AuthUser>('/auth/me', { method: 'PATCH', body: payload }),
  changePassword: (payload: { currentPassword: string; newPassword: string }) =>
    request<{ ok: boolean }>('/auth/password', { method: 'POST', body: payload }),

  /* ---------------- 用户管理 ---------------- */
  listUsers: (signal?: AbortSignal) => request<UserSummary[]>('/users', { signal }),
  createUser: (payload: {
    username: string;
    password: string;
    displayName?: string;
    role?: UserRole;
    timezone?: string;
  }) => request<UserSummary>('/users', { method: 'POST', body: payload }),
  updateUser: (
    id: number,
    payload: { displayName?: string; role?: UserRole; status?: 'active' | 'disabled' },
  ) => request<UserSummary>(`/users/${id}`, { method: 'PATCH', body: payload }),
  resetUserPassword: (id: number, password: string) =>
    request<{ ok: boolean }>(`/users/${id}/password`, { method: 'POST', body: { password } }),

  /* ---------------- 分类 ---------------- */
  listCategories: (signal?: AbortSignal) => request<Category[]>('/categories', { signal }),
  createCategory: (payload: CategoryPayload) =>
    request<Category>('/categories', { method: 'POST', body: payload }),
  updateCategory: (id: number, payload: Partial<CategoryPayload>) =>
    request<Category>(`/categories/${id}`, { method: 'PATCH', body: payload }),
  deleteCategory: (id: number) =>
    request<{ id: number; detachedEventCount: number }>(`/categories/${id}`, { method: 'DELETE' }),
  reorderCategories: (ids: number[]) =>
    request<Category[]>('/categories/order', { method: 'PUT', body: { ids } }),

  /* ---------------- 日程实例 ---------------- */
  listOccurrences: (query: Record<string, QueryValue>, signal?: AbortSignal) =>
    requestEnvelope<Occurrence[]>('/occurrences', { query, signal }) as Promise<
      Envelope<Occurrence[]> & { meta?: OccurrenceMeta }
    >,

  /* ---------------- 日程主体 ---------------- */
  listEvents: (query: Record<string, QueryValue>, signal?: AbortSignal) =>
    requestEnvelope<CalendarEvent[]>('/events', { query, signal }) as Promise<
      Envelope<CalendarEvent[]> & { meta?: PageMeta }
    >,
  createEvent: (payload: EventPayload) =>
    request<CalendarEvent>('/events', { method: 'POST', body: payload }),
  getEvent: (id: number) => request<CalendarEvent>(`/events/${id}`),
  updateEvent: (id: number, payload: Partial<EventPayload>) =>
    request<CalendarEvent>(`/events/${id}`, { method: 'PATCH', body: payload }),
  deleteEvent: (id: number) => request<void>(`/events/${id}`, { method: 'DELETE' }),

  /* ---------------- 实例级操作 ---------------- */
  moveOccurrence: (eventId: number, payload: MoveOccurrencePayload) =>
    request<{
      scope: string;
      event: CalendarEvent | null;
      createdEventId: number | null;
    }>(`/events/${eventId}/move`, { method: 'POST', body: payload }),

  cancelOccurrence: (eventId: number, payload: { occurrenceKey: string; scope?: 'single' | 'future' }) =>
    request<{ scope: string; deleted: boolean }>(`/events/${eventId}/cancel-occurrence`, {
      method: 'POST',
      body: payload,
    }),

  overrideOccurrence: (eventId: number, payload: OccurrenceOverridePayload) =>
    request<unknown>(`/events/${eventId}/override`, { method: 'PUT', body: payload }),

  resetOverride: (eventId: number, occurrenceKey: string) =>
    request<{ removed: boolean }>(`/events/${eventId}/override/${encodeURIComponent(occurrenceKey)}`, {
      method: 'DELETE',
    }),

  /* ---------------- 统计与提醒 ---------------- */
  summary: (query: Record<string, QueryValue>, signal?: AbortSignal) =>
    request<StatsSummary>('/stats/summary', { query, signal }),

  dueReminders: (query: Record<string, QueryValue>, signal?: AbortSignal) =>
    request<ReminderItem[]>('/reminders/due', { query, signal }),

  /* ---------------- 课程同步 ---------------- */
  courseStatus: (signal?: AbortSignal) => request<CourseSyncStatus>('/courses/status', { signal }),
  courseSettings: (signal?: AbortSignal) => request<CourseSyncSettings>('/courses/settings', { signal }),
  updateCourseSettings: (payload: Partial<CourseSyncSettings>) =>
    request<CourseSyncSettings>('/courses/settings', { method: 'PATCH', body: payload }),
  saveCourseCredentials: (payload: { username: string; password: string; remember?: boolean }) =>
    request<CredentialsSummary>('/courses/credentials', { method: 'PUT', body: payload }),
  deleteCourseCredentials: () =>
    request<{ removed: boolean }>('/courses/credentials', { method: 'DELETE' }),
  testCourseLogin: (payload: { username: string; password: string }) =>
    request<{ ok: boolean; baseUrl: string }>('/courses/test-login', { method: 'POST', body: payload }),
  previewCourses: (payload: { username?: string; password?: string } = {}) =>
    request<CoursePreview>('/courses/preview', { method: 'POST', body: payload }),
  importCourses: (payload: { username?: string; password?: string } = {}) =>
    request<CourseImportResult>('/courses/import', { method: 'POST', body: payload }),
  syncCoursesNow: () => request<SyncNowResult>('/courses/sync-now', { method: 'POST' }),

  /* ---------------- 待办 ---------------- */
  listTodos: (query: Record<string, QueryValue>, signal?: AbortSignal) =>
    requestEnvelope<Todo[]>('/todos', { query, signal }) as Promise<
      Envelope<Todo[]> & { meta?: TodoMeta }
    >,
  createTodo: (payload: TodoPayload) => request<Todo>('/todos', { method: 'POST', body: payload }),
  updateTodo: (id: number, payload: Partial<TodoPayload> & { done?: boolean }) =>
    request<Todo>(`/todos/${id}`, { method: 'PATCH', body: payload }),
  deleteTodo: (id: number) => request<void>(`/todos/${id}`, { method: 'DELETE' }),
  reorderTodos: (ids: number[]) =>
    request<Todo[]>('/todos/order', { method: 'PUT', body: { ids } }),

  /* ---------------- 天气 ---------------- */
  weather: (signal?: AbortSignal) => request<WeatherSnapshot>('/weather', { signal }),
  refreshWeather: () => request<WeatherSnapshot>('/weather/refresh', { method: 'POST', body: {} }),
  weatherSettings: (signal?: AbortSignal) => request<WeatherSettings>('/weather/settings', { signal }),
  updateWeatherSettings: (payload: Partial<WeatherSettings>) =>
    request<WeatherSettings>('/weather/settings', { method: 'PUT', body: payload }),
  searchWeather: (q: string, signal?: AbortSignal) =>
    requestEnvelope<{ results: WeatherSearchResult[] }>('/weather/search', {
      query: { q },
      signal,
    }) as Promise<Envelope<{ results: WeatherSearchResult[] }> & { meta?: { warning?: string } }>,

  /* ---------------- 屏幕布局与设备 ---------------- */
  displayConfig: (signal?: AbortSignal) => request<DisplayConfig>('/display', { signal }),
  updateDisplay: (payload: {
    layout?: DisplayLayout;
    refreshMinutes?: number;
    timezone?: string;
  }) => request<DisplayConfig>('/display', { method: 'PUT', body: payload }),
  displayScreen: (signal?: AbortSignal) =>
    request<DeviceScreenPayload>('/display/screen', { signal }),

  listDevices: (signal?: AbortSignal) => request<DeviceSummary[]>('/devices', { signal }),
  createDevice: (payload: { name: string }) =>
    request<CreatedDevice>('/devices', { method: 'POST', body: payload }),
  renameDevice: (id: number, payload: { name: string }) =>
    request<DeviceSummary>(`/devices/${id}`, { method: 'PATCH', body: payload }),
  rotateDeviceToken: (id: number) =>
    request<CreatedDevice>(`/devices/${id}/rotate`, { method: 'POST', body: {} }),
  deleteDevice: (id: number) =>
    request<{ removed: boolean }>(`/devices/${id}`, { method: 'DELETE' }),
};
