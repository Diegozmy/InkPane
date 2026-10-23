/**
 * 课程同步设置。
 *
 * 关键点是「每节课的起止时间」：学校系统只给节次号（第一节…第九节），
 * 不给时间，所以时间必须由用户配置；并且按需求支持周五使用一整套独立时间表。
 * 多用户后每个用户各有一份设置。
 */

import { z } from 'zod';
import type { SqliteDatabase } from '../../db/client.js';
import { get, run } from '../../db/query.js';
import { nowIso } from '../../lib/clock.js';
import { assertCourseUrlLiteralAllowed } from './url-guard.js';

const SETTINGS_KEY = 'course-sync';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const periodTimeSchema = z
  .object({
    index: z.number().int().min(1).max(30),
    start: z.string().regex(TIME_PATTERN, '时间格式必须为 HH:mm'),
    end: z.string().regex(TIME_PATTERN, '时间格式必须为 HH:mm'),
  })
  .strict()
  .refine((value) => value.end > value.start, { message: '结束时间必须晚于开始时间' });

export const courseSyncSettingsSchema = z
  .object({
    baseUrl: z.string().trim().url('必须是合法的网址').max(200),
    periods: z.array(periodTimeSchema).min(1).max(30),
    fridaySeparate: z.boolean(),
    fridayPeriods: z.array(periodTimeSchema).min(1).max(30),
    termStartDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD')
      .nullable(),
    totalWeeks: z.number().int().min(1).max(30),
    autoSync: z.boolean(),
    syncIntervalHours: z.number().int().min(1).max(168),
    includeTeacher: z.boolean(),
    includeRoom: z.boolean(),
    /** 导入到哪个分类；null 表示自动确保存在一个「课程」分类 */
    categoryId: z.number().int().positive().nullable(),
  })
  .strict();

export type CourseSyncSettings = z.infer<typeof courseSyncSettingsSchema>;
export type PeriodTime = z.infer<typeof periodTimeSchema>;

/** 中国大陆高中常见的作息，用户可在界面上逐条修改。 */
export const DEFAULT_PERIODS: PeriodTime[] = [
  { index: 1, start: '08:00', end: '08:40' },
  { index: 2, start: '08:50', end: '09:30' },
  { index: 3, start: '09:40', end: '10:20' },
  { index: 4, start: '10:35', end: '11:15' },
  { index: 5, start: '11:25', end: '12:05' },
  { index: 6, start: '13:30', end: '14:10' },
  { index: 7, start: '14:20', end: '15:00' },
  { index: 8, start: '15:15', end: '15:55' },
  { index: 9, start: '16:05', end: '16:45' },
];

export const DEFAULT_SETTINGS: CourseSyncSettings = {
  baseUrl: 'http://ws8.yucai.sh.cn',
  periods: DEFAULT_PERIODS,
  fridaySeparate: false,
  fridayPeriods: DEFAULT_PERIODS,
  termStartDate: null,
  totalWeeks: 20,
  autoSync: false,
  syncIntervalHours: 6,
  includeTeacher: true,
  includeRoom: true,
  categoryId: null,
};

/* ------------------------------------------------------------------ *
 * 课程同步设置
 * ------------------------------------------------------------------ */

/** 读取设置；字段缺失或非法时用默认值补齐，保证升级后不会因为老数据而报错。 */
export function readCourseSyncSettings(
  db: SqliteDatabase,
  userId: number,
): CourseSyncSettings {
  const row = get<{ value: string }>(
    db,
    'SELECT value FROM app_settings WHERE user_id = ? AND key = ?',
    [userId, SETTINGS_KEY],
  );
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed: unknown = JSON.parse(row.value);
    const result = courseSyncSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...(parsed as object) });
    return result.success ? result.data : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeCourseSyncSettings(
  db: SqliteDatabase,
  userId: number,
  patch: Partial<CourseSyncSettings>,
): CourseSyncSettings {
  const merged = { ...readCourseSyncSettings(db, userId), ...patch };
  const validated = courseSyncSettingsSchema.parse(merged);
  assertCourseBaseUrlAllowed(validated.baseUrl);
  run(
    db,
    `INSERT INTO app_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [userId, SETTINGS_KEY, JSON.stringify(validated), nowIso()],
  );
  return validated;
}

/**
 * 同步兜底校验：写入设置时只做「字面量」检查（纯同步）。
 * 完整的 DNS 校验需要 await，放在 HTTP 路由层与抓取前执行。
 *
 * 保留该函数是为了让任何同步写路径都不会漏掉最基础的协议/私网检查；
 * 校园内网场景可通过 COURSE_ALLOW_PRIVATE_HOSTS=true 显式放开。
 */
export function assertCourseBaseUrlAllowed(raw: string): void {
  assertCourseUrlLiteralAllowed(raw);
}

/**
 * 按节次号取时间表：
 * - 周五且开启了「周五单独时间」时用 fridayPeriods；
 * - 节次超出配置范围时按 50 分钟顺延生成占位时间，并标记为回退，便于界面提示用户去补全。
 */
export function resolvePeriodTime(
  settings: CourseSyncSettings,
  weekday: number,
  period: number,
): { start: string; end: string; fallback: boolean } {
  const table = weekday === 5 && settings.fridaySeparate ? settings.fridayPeriods : settings.periods;
  const hit = table.find((item) => item.index === period);
  if (hit) return { start: hit.start, end: hit.end, fallback: false };

  const last = table.reduce<PeriodTime | null>(
    (acc, item) => (acc === null || item.index > acc.index ? item : acc),
    null,
  );
  const baseMinutes = last ? toMinutes(last.end) + 10 : 8 * 60;
  const start = fromMinutes(baseMinutes + (period - (last?.index ?? 0) - 1) * 50);
  return { start, end: fromMinutes(toMinutes(start) + 40), fallback: true };
}

/** 把课表里出现过的节次补齐进时间表，避免出现回退时间。 */
export function extendPeriodsTo(periods: PeriodTime[], maxPeriod: number): PeriodTime[] {
  if (maxPeriod <= periods.length) return periods;
  const next = [...periods];
  const cursor = next.reduce<PeriodTime | null>(
    (acc, item) => (acc === null || item.index > acc.index ? item : acc),
    null,
  );
  let minutes = cursor ? toMinutes(cursor.end) + 10 : 8 * 60;
  for (let index = periods.length + 1; index <= maxPeriod; index += 1) {
    const start = fromMinutes(minutes);
    const end = fromMinutes(minutes + 40);
    next.push({ index, start, end });
    minutes += 50;
  }
  return next;
}

function toMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function fromMinutes(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return `${`${Math.floor(normalized / 60)}`.padStart(2, '0')}:${`${normalized % 60}`.padStart(2, '0')}`;
}
