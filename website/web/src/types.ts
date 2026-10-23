/** 与后端共享的数据契约（手写镜像，保持前后端字段一致）。 */

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type EventStatus = 'confirmed' | 'tentative' | 'cancelled';
export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type MoveScope = 'single' | 'all' | 'future';
export type CalendarView = 'month' | 'week' | 'day';

export interface RecurrenceRule {
  freq: RecurrenceFrequency;
  interval: number;
  byWeekday?: number[];
  count?: number;
  until?: string;
}

export interface Category {
  id: number;
  name: string;
  color: string;
  icon: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryPayload {
  name: string;
  color: string;
  icon?: string | null;
  sortOrder?: number;
}

/** 展开后的日程实例：日历渲染的唯一数据形状。 */
export interface Occurrence {
  id: string;
  eventId: number;
  occurrenceKey: string;
  title: string;
  description: string;
  location: string;
  categoryId: number | null;
  priority: Priority;
  status: EventStatus;
  allDay: boolean;
  /** 定时事件为 ISO UTC；全天事件为 YYYY-MM-DD */
  startAt: string;
  endAt: string;
  timezone: string;
  tags: string[];
  color: string | null;
  remindMinutesBefore: number | null;
  isRecurring: boolean;
  isModified: boolean;
  rrule: RecurrenceRule | null;
}

/** 日程主体（未展开）。 */
export interface CalendarEvent {
  id: number;
  title: string;
  description: string;
  location: string;
  categoryId: number | null;
  priority: Priority;
  status: EventStatus;
  allDay: boolean;
  startAt: string;
  endAt: string;
  timezone: string;
  tags: string[];
  rrule: RecurrenceRule | null;
  color: string | null;
  remindMinutesBefore: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventPayload {
  title: string;
  description?: string;
  location?: string;
  categoryId?: number | null;
  priority?: Priority;
  status?: EventStatus;
  allDay?: boolean;
  startAt: string;
  endAt: string;
  timezone?: string;
  tags?: string[];
  rrule?: RecurrenceRule | null;
  color?: string | null;
  remindMinutesBefore?: number | null;
}

export interface MoveOccurrencePayload {
  occurrenceKey: string;
  scope?: MoveScope;
  startAt: string;
  endAt: string;
  allDay?: boolean;
}

export interface OccurrenceOverridePayload {
  occurrenceKey: string;
  title?: string | null;
  description?: string | null;
  location?: string | null;
  priority?: Priority | null;
  categoryId?: number | null;
  startAt?: string | null;
  endAt?: string | null;
  allDay?: boolean | null;
  tags?: string[] | null;
}

export interface Filters {
  q: string;
  categoryIds: number[];
  priorities: Priority[];
  statuses: EventStatus[];
  tags: string[];
  includeCancelled: boolean;
}

export const EMPTY_FILTERS: Filters = {
  q: '',
  categoryIds: [],
  priorities: [],
  statuses: [],
  tags: [],
  includeCancelled: false,
};

export interface CategoryStat {
  categoryId: number | null;
  name: string;
  color: string;
  count: number;
}

export interface StatsSummary {
  rangeFrom: string;
  rangeTo: string;
  totalOccurrences: number;
  totalMinutes: number;
  allDayCount: number;
  recurringCount: number;
  byCategory: CategoryStat[];
  byPriority: { priority: Priority; count: number }[];
  byDay: { date: string; count: number }[];
  upcoming: Occurrence[];
}

export interface ReminderItem {
  id: string;
  eventId: number;
  occurrenceKey: string;
  title: string;
  location: string;
  categoryId: number | null;
  startAt: string;
  allDay: boolean;
  fireAt: string;
  minutesBefore: number;
}

export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface OccurrenceMeta {
  range: { from: string; to: string };
  timezone: string;
  count: number;
  truncated: boolean;
}

export interface HealthInfo {
  status: string;
  env: string;
  schemaVersion: number;
  uptimeSeconds: number;
  serverTime: string;
}

/* ------------------------------------------------------------------ *
 * 课程同步（对接学校课程管理系统）
 * ------------------------------------------------------------------ */

export interface PeriodTime {
  index: number;
  start: string;
  end: string;
}

export interface CourseSyncSettings {
  baseUrl: string;
  /** 周一至周四、周六、周日共用的节次时间 */
  periods: PeriodTime[];
  /** 勾选后周五使用下面这整套独立时间 */
  fridaySeparate: boolean;
  fridayPeriods: PeriodTime[];
  /** 本学期第一周周一（YYYY-MM-DD） */
  termStartDate: string | null;
  totalWeeks: number;
  autoSync: boolean;
  syncIntervalHours: number;
  includeTeacher: boolean;
  includeRoom: boolean;
  categoryId: number | null;
}

export interface CredentialsSummary {
  username: string | null;
  hasPassword: boolean;
  passwordMask: string | null;
  remember: boolean;
  updatedAt: string | null;
}

export interface PreviewSlot {
  externalKey: string;
  weekday: number;
  weekdayLabel: string;
  period: number;
  courseName: string;
  teacher: string;
  room: string;
  firstStartAt: string;
  firstEndAt: string;
  timeFallback: boolean;
  willUpdate: boolean;
}

export interface CoursePreview {
  termId: string | null;
  termName: string | null;
  weekDates: { weekday: number; weekdayLabel: string; dateKey: string }[];
  periodNumbers: number[];
  slots: PreviewSlot[];
  termStartDate: string;
  totalWeeks: number;
  termStartInferred: boolean;
  warnings: string[];
  fetchedAt: string;
}

export interface CourseImportResult {
  slots: PreviewSlot[];
  termId: string | null;
  termName: string | null;
  termStartDate: string;
  totalWeeks: number;
  warnings: string[];
  created: number;
  updated: number;
  removed: number;
  categoryId: number;
}

export interface SyncRun {
  id: number;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'success' | 'failed';
  message: string;
  created: number;
  updated: number;
  removed: number;
  total: number;
}

export interface CourseSyncStatus {
  credentials: CredentialsSummary;
  settings: CourseSyncSettings;
  lastRun: SyncRun | null;
  linkedCount: number;
  autoSyncEnabled: boolean;
  schedulerIntervalMs: number;
  serverTime: string;
}

export interface SyncNowResult {
  created: number;
  updated: number;
  removed: number;
  total: number;
}

/* ------------------------------------------------------------------ *
 * 待办清单
 * ------------------------------------------------------------------ */

export interface Todo {
  id: number;
  title: string;
  notes: string;
  done: boolean;
  priority: Priority;
  /** YYYY-MM-DD */
  dueDate: string | null;
  categoryId: number | null;
  sortOrder: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TodoPayload {
  title: string;
  notes?: string;
  priority?: Priority;
  dueDate?: string | null;
  categoryId?: number | null;
  sortOrder?: number;
}

export interface TodoMeta {
  total: number;
  limit: number;
  offset: number;
}

/* ------------------------------------------------------------------ *
 * 天气（Open-Meteo 缓存快照）
 * ------------------------------------------------------------------ */

export type WeatherIcon =
  | 'clear'
  | 'partly-cloudy'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'snow'
  | 'thunderstorm';

export interface WeatherCurrent {
  temperature: number;
  apparentTemperature: number;
  humidity: number;
  weatherCode: number;
  condition: string;
  icon: WeatherIcon;
  windSpeed: number;
  isDay: boolean;
}

export interface WeatherDay {
  date: string;
  weekday: string;
  min: number;
  max: number;
  condition: string;
  icon: WeatherIcon;
  precipitationProbability: number;
}

export interface WeatherToday {
  date: string;
  min: number;
  max: number;
  condition: string;
  icon: WeatherIcon;
  precipitationProbability: number;
}

export interface WeatherSnapshot {
  provider: 'open-meteo';
  city: string;
  latitude: number;
  longitude: number;
  observedAt: string;
  fetchedAt: string;
  stale: boolean;
  source: 'open-meteo' | 'cache' | 'fallback';
  message?: string;
  current: WeatherCurrent;
  today: WeatherToday;
  forecast: WeatherDay[];
}

export interface WeatherSettings {
  city: string;
  latitude: number;
  longitude: number;
  enabled: boolean;
  timezone: string;
  updatedAt: string;
}

export interface WeatherSearchResult {
  name: string;
  /** Open-Meteo 未提供时为空字符串 */
  admin1: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

/* ------------------------------------------------------------------ *
 * 电子墨水屏布局
 * ------------------------------------------------------------------ */

export const DISPLAY_WIDTH = 800;
export const DISPLAY_HEIGHT = 480;

export type DisplayModuleId = 'clock' | 'calendar' | 'weather' | 'schedule' | 'courses' | 'todos';

export interface DisplayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DisplayModule extends DisplayRect {
  id: DisplayModuleId;
  enabled: boolean;
}

export interface DisplayLayout {
  width: number;
  height: number;
  updatedAt: string;
  modules: DisplayModule[];
}

export interface DisplayModuleMeta {
  id: DisplayModuleId;
  name: string;
  description: string;
  defaultRect: DisplayRect;
}

export interface DisplayConfig {
  layout: DisplayLayout;
  refreshMinutes: number;
  timezone: string;
  modules: DisplayModuleMeta[];
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * 设备对接
 * ------------------------------------------------------------------ */

export interface DeviceEvent {
  id: string;
  eventId: number;
  occurrenceKey: string;
  title: string;
  location: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  categoryId: number | null;
  color: string | null;
  priority: Priority;
  isCourse: boolean;
}

export interface DeviceTodo {
  id: number;
  title: string;
  priority: Priority;
  dueDate: string | null;
}

export interface DeviceMonth {
  year: number;
  month: number;
  /** 0 = 周日 */
  firstWeekday: number;
  daysInMonth: number;
  today: number;
  marks: number[];
}

export interface DeviceScreenPayload {
  schemaVersion: number;
  generatedAt: string;
  timezone: string;
  etag: string;
  device: { id: number; name: string } | null;
  screen: {
    width: number;
    height: number;
    refreshMinutes: number;
    layout: DisplayLayout;
  };
  now: {
    iso: string;
    time: string;
    weekday: string;
    date: string;
    dateLabel: string;
    epochSeconds: number;
    utcOffsetMinutes: number;
    localIso: string;
  };
  month: DeviceMonth;
  weather: WeatherSnapshot | null;
  events: DeviceEvent[];
  courses: DeviceEvent[];
  todos: DeviceTodo[];
}

export type UserRole = 'admin' | 'user';
export type UserStatus = 'pending_setup' | 'active' | 'disabled';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  timezone: string;
}

export interface AuthSession {
  user: AuthUser;
  setupRequired: boolean;
}

export interface SetupStatus {
  required: boolean;
  /** 服务端要求初始化时提供一次性初始化码（通常仅非回环访问时开启） */
  codeRequired: boolean;
}

export interface UserSummary extends AuthUser {
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  deviceCount: number;
}

export interface DeviceSummary {
  id: number;
  name: string;
  tokenPrefix: string;
  lastSeenAt: string | null;
  online: boolean;
  firmware: string | null;
  batteryPercent: number | null;
  batteryVoltage: number | null;
  rssi: number | null;
  indoorTemperature: number | null;
  indoorHumidity: number | null;
  createdAt: string;
}

export interface CreatedDevice {
  device: DeviceSummary;
  token: string;
}

export interface DeviceTelemetryPayload {
  temperature?: number;
  humidity?: number;
  batteryVoltage?: number;
  batteryPercent?: number;
  rssi?: number;
  firmware?: string;
  uptimeSeconds?: number;
}
