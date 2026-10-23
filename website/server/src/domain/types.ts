/** 统一的领域类型定义：数据库行、领域实体与对外 DTO。 */

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const RECURRENCE_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

/**
 * 重复规则。
 *
 * `byWeekday` 使用 0=周日 ... 6=周六，仅对 WEEKLY 生效。
 * `until` 是该事件时区下的“墙上时间”日期或日期时间字符串，语义为“包含该时刻”。
 * `count` 与 `until` 互斥，若同时给出以 count 优先。
 */
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

export interface CategoryInput {
  name: string;
  color: string;
  icon?: string | null;
  sortOrder?: number;
}

export interface EventRecord {
  id: number;
  title: string;
  description: string;
  location: string;
  categoryId: number | null;
  priority: Priority;
  status: EventStatus;
  allDay: boolean;
  /** ISO-8601 UTC 瞬间；全天事件为 'YYYY-MM-DD' 日期串 */
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

/** 事件主体字段的可选更新集合。 */
export interface EventInput {
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

/** 针对某个重复实例的覆盖（改期、改内容）或取消。 */
export interface EventOverride {
  id: number;
  eventId: number;
  occurrenceKey: string;
  cancelled: boolean;
  title: string | null;
  description: string | null;
  location: string | null;
  priority: Priority | null;
  startAt: string | null;
  endAt: string | null;
  allDay: boolean | null;
  categoryId: number | null;
  tags: string[] | null;
  createdAt: string;
  updatedAt: string;
}

/** 展开后的单个日程实例，是前端渲染的唯一数据形状。 */
export interface Occurrence {
  /** 稳定标识：`${eventId}:${occurrenceKey}` */
  id: string;
  eventId: number;
  /** 该实例在原始序列中的起始时刻，用作覆盖/取消的键 */
  occurrenceKey: string;
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
  color: string | null;
  remindMinutesBefore: number | null;
  isRecurring: boolean;
  /** 该实例是否被单独修改过 */
  isModified: boolean;
  rrule: RecurrenceRule | null;
}

export interface OccurrenceQuery {
  from: string;
  to: string;
  search?: string;
  categoryIds?: number[];
  priorities?: Priority[];
  statuses?: EventStatus[];
  tags?: string[];
  includeCancelled?: boolean;
  limit?: number;
}

export interface MoveOccurrenceInput {
  occurrenceKey: string;
  scope: 'single' | 'all' | 'future';
  startAt: string;
  endAt: string;
  allDay?: boolean;
}

export interface StatsSummary {
  rangeFrom: string;
  rangeTo: string;
  totalOccurrences: number;
  totalMinutes: number;
  allDayCount: number;
  recurringCount: number;
  byCategory: { categoryId: number | null; name: string; color: string; count: number }[];
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
  /** 提醒应当触发的瞬间（ISO UTC） */
  fireAt: string;
  minutesBefore: number;
}

/* ------------------------------------------------------------------ *
 * 待办
 * ------------------------------------------------------------------ */

export interface Todo {
  id: number;
  title: string;
  notes: string;
  done: boolean;
  priority: Priority;
  /** YYYY-MM-DD；无截止日期为 null */
  dueDate: string | null;
  categoryId: number | null;
  sortOrder: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * 天气
 * ------------------------------------------------------------------ */

export const WEATHER_ICONS = [
  'clear',
  'partly-cloudy',
  'cloudy',
  'fog',
  'drizzle',
  'rain',
  'snow',
  'thunderstorm',
] as const;
export type WeatherIcon = (typeof WEATHER_ICONS)[number];

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

export interface WeatherToday {
  date: string;
  min: number;
  max: number;
  precipitationProbability: number;
  condition: string;
  icon: WeatherIcon;
}

export interface WeatherForecastDay {
  date: string;
  weekday: string;
  min: number;
  max: number;
  condition: string;
  icon: WeatherIcon;
  precipitationProbability: number;
}

/** 对外统一的天气快照；缓存、强制刷新与回退都返回这个形状。 */
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
  /** 含今天在内共 3 天 */
  forecast: WeatherForecastDay[];
}

export interface WeatherSettingsView {
  city: string;
  latitude: number;
  longitude: number;
  enabled: boolean;
  timezone: string;
  updatedAt: string;
}

export interface WeatherSearchResult {
  name: string;
  admin1: string;
  country: string;
  latitude: number;
  longitude: number;
  timezone: string;
}

/* ------------------------------------------------------------------ *
 * 屏幕布局
 * ------------------------------------------------------------------ */

export const DISPLAY_MODULE_IDS = ['clock', 'calendar', 'weather', 'schedule', 'courses', 'todos'] as const;
export type DisplayModuleId = (typeof DISPLAY_MODULE_IDS)[number];

/** 墨水屏逻辑分辨率，布局坐标都以它为基准。 */
export const DISPLAY_WIDTH = 800;
export const DISPLAY_HEIGHT = 480;

export interface DisplayModule {
  id: DisplayModuleId;
  enabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DisplayLayout {
  width: number;
  height: number;
  updatedAt: string;
  modules: DisplayModule[];
}

export interface DisplayModuleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 前端布局编辑器所需的模块目录。 */
export interface DisplayModuleCatalogItem {
  id: DisplayModuleId;
  name: string;
  description: string;
  defaultRect: DisplayModuleRect;
}

export interface DisplayConfig {
  layout: DisplayLayout;
  refreshMinutes: number;
  timezone: string;
  modules: DisplayModuleCatalogItem[];
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * 设备屏幕
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

export interface DeviceNow {
  iso: string;
  time: string;
  weekday: string;
  date: string;
  dateLabel: string;
  /** 服务端当前 Unix 秒，供设备校准 RTC */
  epochSeconds: number;
  /** 用户显示时区相对 UTC 的偏移分钟数（东八区为 480） */
  utcOffsetMinutes: number;
  /** 用户时区下的本地墙上时间，含秒；用于直接写 RTC */
  localIso: string;
}

export interface DeviceMonth {
  year: number;
  month: number;
  /** 当月 1 日是星期几，0 = 周日 */
  firstWeekday: number;
  daysInMonth: number;
  today: number;
  /** 当月有日程的日期号，升序 */
  marks: number[];
}

export interface DeviceScreen {
  width: number;
  height: number;
  refreshMinutes: number;
  layout: DisplayLayout;
}

export interface DeviceIdentity {
  id: number;
  name: string;
}

/** ESP32 拉取的完整屏幕数据。 */
export interface DeviceScreenPayload {
  schemaVersion: number;
  generatedAt: string;
  timezone: string;
  etag: string;
  device: DeviceIdentity | null;
  screen: DeviceScreen;
  now: DeviceNow;
  month: DeviceMonth;
  weather: WeatherSnapshot | null;
  /** 今日非课程日程，最多 32 条（按开始时间升序） */
  events: DeviceEvent[];
  /** 今日课程日程，最多 16 条 */
  courses: DeviceEvent[];
  /** 未完成待办，最多 8 条 */
  todos: DeviceTodo[];
  /** 今日非课程日程的真实总数（events 可能被截断） */
  eventTotal: number;
  /** 今日课程日程的真实总数（courses 可能被截断） */
  courseTotal: number;
  /** 未完成待办的真实总数（todos 可能被截断） */
  todoTotal: number;
}

export interface DeviceTelemetry {
  temperature?: number;
  humidity?: number;
  batteryVoltage?: number;
  batteryPercent?: number;
  rssi?: number;
  firmware?: string;
  uptimeSeconds?: number;
}

/** 控制台「设备」页展示的状态（多设备版）。 */
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

/** 兼容旧类型名的字段集合；新代码使用 DeviceSummary。 */
export interface DeviceStatus {
  paired: boolean;
  name: string;
  tokenPreview: string;
  lastSeenAt: string | null;
  firmware: string | null;
  batteryPercent: number | null;
  batteryVoltage: number | null;
  rssi: number | null;
  indoorTemperature: number | null;
  indoorHumidity: number | null;
  screenVersion: string;
  refreshMinutes: number;
  layoutUpdatedAt: string;
  serverTime: string;
}
