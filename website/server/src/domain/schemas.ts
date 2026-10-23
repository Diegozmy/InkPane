/** 请求体与查询参数的 Zod 校验模式。所有入口数据必须先经过这里。 */

import { z } from 'zod';
import {
  DISPLAY_HEIGHT,
  DISPLAY_MODULE_IDS,
  DISPLAY_WIDTH,
  EVENT_STATUSES,
  PRIORITIES,
  RECURRENCE_FREQUENCIES,
} from './types.js';
import { isValidDateKey, isValidTimeZone } from './time.js';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** 接受任意可解析的时间串（ISO 带偏移、UTC、或纯日期），统一规范化为 ISO UTC。 */
export const instantSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((value) => !Number.isNaN(new Date(value).getTime()), {
    message: '不是合法的时间格式',
  })
  .transform((value) => new Date(value).toISOString());

/** 全天事件使用纯日期串，避免时区导致日期偏移。 */
export const dateKeySchema = z
  .string()
  .trim()
  .regex(DATE_KEY, '日期格式必须为 YYYY-MM-DD')
  .refine((value) => isValidDateKey(value), { message: '该日期在日历上不存在' });

/**
 * 事件时间入参：既接受 'YYYY-MM-DD'（全天事件），也接受任何可解析的时间串。
 * 日期串原样保留，绝不经过 UTC 往返，因此不会因时区导致日期漂移。
 */
export const dateOrInstantSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((value) => isValidDateKey(value) || !Number.isNaN(new Date(value).getTime()), {
    message: '时间格式非法，需为 YYYY-MM-DD 或可解析的时间串',
  })
  .transform((value) => (isValidDateKey(value) ? value : new Date(value).toISOString()));

export const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => isValidTimeZone(value), { message: '时区标识无效（需为 IANA 名称，如 Asia/Shanghai）' });

export const colorSchema = z.string().trim().regex(HEX_COLOR, '颜色必须是 #RRGGBB 形式');

export const recurrenceRuleSchema = z
  .object({
    freq: z.enum(RECURRENCE_FREQUENCIES),
    interval: z.number().int().min(1).max(365).default(1),
    byWeekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    count: z.number().int().min(1).max(500).optional(),
    until: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export const tagsSchema = z.array(z.string().trim().min(1).max(30)).max(20);

/** ---- 分类 ---- */

export const categoryCreateSchema = z
  .object({
    name: z.string().trim().min(1, '分类名称不能为空').max(30),
    color: colorSchema,
    icon: z.string().trim().max(40).nullable().optional(),
    sortOrder: z.number().int().min(-999).max(999).optional(),
  })
  .strict();

export const categoryUpdateSchema = categoryCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: '至少需要提供一个待更新字段' },
);

/** ---- 事件 ---- */

const eventBaseShape = {
  title: z.string().trim().min(1, '标题不能为空').max(120),
  description: z.string().max(4000).optional(),
  location: z.string().trim().max(200).optional(),
  categoryId: z.number().int().positive().nullable().optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  allDay: z.boolean().optional(),
  startAt: dateOrInstantSchema,
  endAt: dateOrInstantSchema,
  timezone: timezoneSchema.optional(),
  tags: tagsSchema.optional(),
  rrule: recurrenceRuleSchema.nullable().optional(),
  color: colorSchema.nullable().optional(),
  remindMinutesBefore: z.number().int().min(0).max(20_160).nullable().optional(),
};

export const eventCreateSchema = z.object(eventBaseShape).strict();

export const eventUpdateSchema = z
  .object(eventBaseShape)
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要提供一个待更新字段' });

/** ---- 实例操作 ---- */

export const moveOccurrenceSchema = z
  .object({
    occurrenceKey: z.string().trim().min(1).max(60),
    scope: z.enum(['single', 'all', 'future']).optional(),
    startAt: dateOrInstantSchema,
    endAt: dateOrInstantSchema,
    allDay: z.boolean().optional(),
  })
  .strict();

export const cancelOccurrenceSchema = z
  .object({
    occurrenceKey: z.string().trim().min(1).max(60),
    scope: z.enum(['single', 'future']).optional(),
  })
  .strict();

export const overrideSchema = z
  .object({
    occurrenceKey: z.string().trim().min(1).max(60),
    title: z.string().trim().min(1).max(120).nullable().optional(),
    description: z.string().max(4000).nullable().optional(),
    location: z.string().trim().max(200).nullable().optional(),
    priority: z.enum(PRIORITIES).nullable().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    startAt: dateOrInstantSchema.nullable().optional(),
    endAt: dateOrInstantSchema.nullable().optional(),
    allDay: z.boolean().nullable().optional(),
    tags: tagsSchema.nullable().optional(),
  })
  .strict();

/* ------------------------------------------------------------------ *
 * 查询参数
 * ------------------------------------------------------------------ */

/** 逗号分隔的多值查询参数 → 数组。 */
function csvOf<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      const parts = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return parts.length > 0 ? parts : undefined;
    }
    return value;
  }, inner);
}

function booleanQuery(defaultValue?: boolean) {
  const base = z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    }
    return value;
  }, z.boolean());
  return defaultValue === undefined ? base.optional() : base.default(defaultValue);
}

export const occurrenceQuerySchema = z
  .object({
    from: instantSchema.optional(),
    to: instantSchema.optional(),
    q: z.string().trim().max(200).optional(),
    categoryId: csvOf(z.array(z.coerce.number().int().positive())).optional(),
    priority: csvOf(z.array(z.enum(PRIORITIES))).optional(),
    status: csvOf(z.array(z.enum(EVENT_STATUSES))).optional(),
    tag: csvOf(z.array(z.string().trim().min(1).max(30))).optional(),
    includeCancelled: booleanQuery(false),
    limit: z.coerce.number().int().min(1).max(2000).optional(),
  })
  .strict();

export const statsQuerySchema = z
  .object({
    from: instantSchema.optional(),
    to: instantSchema.optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();

export const reminderQuerySchema = z
  .object({
    from: instantSchema.optional(),
    to: instantSchema.optional(),
    windowMinutes: z.coerce.number().int().min(1).max(20_160).optional(),
  })
  .strict();

export const listEventsQuerySchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    categoryId: csvOf(z.array(z.coerce.number().int().positive())).optional(),
    priority: csvOf(z.array(z.enum(PRIORITIES))).optional(),
    status: csvOf(z.array(z.enum(EVENT_STATUSES))).optional(),
    tag: csvOf(z.array(z.string().trim().min(1).max(30))).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
    sort: z.enum(['startAt', '-startAt', 'createdAt', '-createdAt', 'title', '-title']).optional(),
  })
  .strict();

export const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export type OccurrenceQueryInput = z.infer<typeof occurrenceQuerySchema>;
export type EventCreateInput = z.infer<typeof eventCreateSchema>;
export type EventUpdateInput = z.infer<typeof eventUpdateSchema>;
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;
export type MoveOccurrenceInputDto = z.infer<typeof moveOccurrenceSchema>;
export type CancelOccurrenceInputDto = z.infer<typeof cancelOccurrenceSchema>;
export type OverrideInputDto = z.infer<typeof overrideSchema>;
export type StatsQueryInput = z.infer<typeof statsQuerySchema>;
export type ReminderQueryInput = z.infer<typeof reminderQuerySchema>;
export type ListEventsQueryInput = z.infer<typeof listEventsQuerySchema>;

/* ------------------------------------------------------------------ *
 * 待办
 * ------------------------------------------------------------------ */

const TODO_TITLE_MAX = 200;

export const todoCreateSchema = z
  .object({
    title: z.string().trim().min(1, '待办标题不能为空').max(TODO_TITLE_MAX),
    notes: z.string().max(4000).optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: dateKeySchema.nullable().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  })
  .strict();

export const todoUpdateSchema = z
  .object({
    title: z.string().trim().min(1, '待办标题不能为空').max(TODO_TITLE_MAX).optional(),
    notes: z.string().max(4000).optional(),
    done: z.boolean().optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: dateKeySchema.nullable().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要提供一个待更新字段' });

export const todoListQuerySchema = z
  .object({
    done: booleanQuery(),
    due: z.enum(['today', 'week']).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
  })
  .strict();

export const todoOrderSchema = z
  .object({
    ids: z.array(z.number().int().positive()).max(2000),
  })
  .strict();

export type TodoCreateInput = z.infer<typeof todoCreateSchema>;
export type TodoUpdateInput = z.infer<typeof todoUpdateSchema>;
export type TodoListQueryInput = z.infer<typeof todoListQuerySchema>;

/* ------------------------------------------------------------------ *
 * 屏幕布局
 * ------------------------------------------------------------------ */

/** 布局坐标必须落在 4 像素网格上，墨水屏渲染才不会出现半像素模糊。 */
function gridCoordinate(min: number, message: string) {
  return z
    .number()
    .int('必须是整数')
    .min(min, message)
    .refine((value) => value % 4 === 0, { message: '必须是 4 的倍数' });
}

export const displayModuleSchema = z
  .object({
    id: z.enum(DISPLAY_MODULE_IDS),
    enabled: z.boolean(),
    x: gridCoordinate(0, 'x 不能小于 0'),
    y: gridCoordinate(0, 'y 不能小于 0'),
    w: gridCoordinate(80, 'w 不能小于 80'),
    h: gridCoordinate(48, 'h 不能小于 48'),
  })
  .strict();

export const displayLayoutSchema = z
  .object({
    width: z.literal(DISPLAY_WIDTH, { message: `宽度必须为 ${DISPLAY_WIDTH}` }),
    height: z.literal(DISPLAY_HEIGHT, { message: `高度必须为 ${DISPLAY_HEIGHT}` }),
    // 整体覆盖时 updatedAt 由服务端刷新；允许客户端回传但会被忽略
    updatedAt: z.string().trim().min(1).max(40).optional(),
    modules: z.array(displayModuleSchema).length(6, '布局必须包含 6 个模块'),
  })
  .strict()
  .superRefine((layout, ctx) => {
    const seen = new Set<string>();
    layout.modules.forEach((module, index) => {
      if (seen.has(module.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modules', index, 'id'],
          message: `模块 ${module.id} 重复`,
        });
      }
      seen.add(module.id);
      if (module.x + module.w > DISPLAY_WIDTH) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modules', index],
          message: `模块 ${module.id} 超出屏幕右边界`,
        });
      }
      if (module.y + module.h > DISPLAY_HEIGHT) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modules', index],
          message: `模块 ${module.id} 超出屏幕下边界`,
        });
      }
    });
    for (const id of DISPLAY_MODULE_IDS) {
      if (!seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modules'],
          message: `缺少模块 ${id}`,
        });
      }
    }
  });

export const displayUpdateSchema = z
  .object({
    layout: displayLayoutSchema.optional(),
    refreshMinutes: z.number().int().min(5).max(720).optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();

export type DisplayUpdateInput = z.infer<typeof displayUpdateSchema>;

/* ------------------------------------------------------------------ *
 * 天气设置与搜索
 * ------------------------------------------------------------------ */

export const weatherSettingsUpdateSchema = z
  .object({
    city: z.string().trim().min(1, '城市名称不能为空').max(60).optional(),
    latitude: z.number().min(-90, '纬度必须在 -90 到 90 之间').max(90, '纬度必须在 -90 到 90 之间').optional(),
    longitude: z
      .number()
      .min(-180, '经度必须在 -180 到 180 之间')
      .max(180, '经度必须在 -180 到 180 之间')
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要提供一个待更新字段' });

export const weatherSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1, '搜索关键词不能为空').max(50),
  })
  .strict();

export type WeatherSettingsUpdateInput = z.infer<typeof weatherSettingsUpdateSchema>;

/* ------------------------------------------------------------------ *
 * 设备
 * ------------------------------------------------------------------ */

export const deviceTelemetrySchema = z
  .object({
    temperature: z.number().finite().optional(),
    humidity: z.number().finite().optional(),
    batteryVoltage: z.number().finite().optional(),
    batteryPercent: z.number().int().min(0).max(100).optional(),
    rssi: z.number().int().min(-120).max(0).optional(),
    firmware: z.string().trim().min(1).max(64).optional(),
    uptimeSeconds: z.number().int().min(0).optional(),
  })
  .strict();

export const deviceSettingsSchema = z
  .object({
    name: z.string().trim().min(1, '设备名称不能为空').max(40).optional(),
    refreshMinutes: z.number().int().min(5).max(720).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要提供一个待更新字段' });

export type DeviceTelemetryInput = z.infer<typeof deviceTelemetrySchema>;
export type DeviceSettingsInput = z.infer<typeof deviceSettingsSchema>;
