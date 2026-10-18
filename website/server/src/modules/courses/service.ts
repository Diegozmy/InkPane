/**
 * 课程导入与自动同步服务。
 *
 * 幂等策略：每条课表条目（学程 + 星期 + 节次）在 course_slot_links 里有一条映射，
 * 重复导入只会更新对应的日程，不会产生重复；课表里消失的条目会被删除。
 * 因此「同步」可以用任意频率反复执行。
 */

import { z } from 'zod';
import { getDatabase, transaction, type SqliteDatabase } from '../../db/client.js';
import { all, get, run } from '../../db/query.js';
import { AppError, BadRequestError, ValidationError } from '../../http/errors.js';
import { nowIso } from '../../lib/clock.js';
import { logger } from '../../lib/logger.js';
import {
  addDaysToDateKey,
  systemTimeZone,
  toDateKey,
  weekdayOfDateKey,
  wallTimeToInstant,
} from '../../domain/time.js';
import { createCategory, listCategories } from '../categories.js';
import { createEvent, getEvent, updateEvent } from '../events/service.js';
import type { EventRecord, RecurrenceRule } from '../../domain/types.js';
import { SchoolPortalClient, SchoolPortalError } from './client.js';
import type { SchoolCredentials, SchoolTimetable } from './client.js';
import { buildTimetable, slotExternalKey } from './parser.js';
import { COURSE_SOURCE, describeCredentials, readCredentials } from './credentials.js';
import {
  readCourseSyncSettings,
  resolvePeriodTime,
  writeCourseSyncSettings,
  type CourseSyncSettings,
} from './settings.js';

const CATEGORY_NAME = '课程';
const CATEGORY_COLOR = '#2f6e9e';

export const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/* ------------------------------------------------------------------ *
 * 抓取器（可注入，便于测试）
 * ------------------------------------------------------------------ */

export interface TimetableFetchResult {
  html: string;
  baseUrl: string;
  fetchedAt: string;
}

export type TimetableFetcher = (
  credentials: SchoolCredentials,
  baseUrl: string,
) => Promise<TimetableFetchResult>;

export const defaultFetcher: TimetableFetcher = async (credentials, baseUrl) => {
  const client = new SchoolPortalClient({ baseUrl });
  await client.login(credentials);
  const html = await client.fetchTimetableHtml();
  return { html, baseUrl, fetchedAt: nowIso() };
};

/** 把客户端错误翻译成对用户可操作的提示。 */
export function translatePortalError(error: unknown): never {
  if (error instanceof SchoolPortalError) {
    switch (error.kind) {
      case 'network':
        throw new BadRequestError(error.message, { detail: error.detail });
      case 'auth':
        throw new ValidationError(`学校系统拒绝了这次登录：${error.message}`, {
          hint: '请核对账号密码；若确认无误，可能需要在校园网内、或先在校内门户修改密码后再试',
        });
      case 'credentials':
        throw new ValidationError(error.message);
      default:
        throw new BadRequestError(`学校系统返回了无法识别的内容：${error.message}`, {
          detail: error.detail,
        });
    }
  }
  throw error;
}

/* ------------------------------------------------------------------ *
 * 预览
 * ------------------------------------------------------------------ */

export interface PreviewSlot {
  externalKey: string;
  weekday: number;
  weekdayLabel: string;
  period: number;
  courseName: string;
  teacher: string;
  room: string;
  /** 该条目在本学期第一次上课的本地时间 */
  firstStartAt: string;
  firstEndAt: string;
  /** 时间是否来自兜底推断（说明节次时间没配全） */
  timeFallback: boolean;
  /** 已存在同位置日程时为 true，导入将执行更新 */
  willUpdate: boolean;
}

export interface CoursePreview {
  termId: string | null;
  termName: string | null;
  weekDates: { weekday: number; weekdayLabel: string; dateKey: string }[];
  periodNumbers: number[];
  slots: PreviewSlot[];
  /** 学期第一周周一 */
  termStartDate: string;
  totalWeeks: number;
  /** 该起始日是按当周推断出来的（用户没显式配置） */
  termStartInferred: boolean;
  warnings: string[];
  fetchedAt: string;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** 取某天所在周的周一。 */
export function mondayOf(dateKey: string): string {
  const weekday = weekdayOfDateKey(dateKey); // 0=周日
  const offset = weekday === 0 ? 6 : weekday - 1;
  return addDaysToDateKey(dateKey, -offset);
}

function localDateTimeToInstant(dateKey: string, time: string, timezone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return wallTimeToInstant(
    { year: year ?? 1970, month: month ?? 1, day: day ?? 1, hour: hour ?? 0, minute: minute ?? 0 },
    timezone,
  );
}

interface BuildPreviewInput {
  timetable: SchoolTimetable;
  settings: CourseSyncSettings;
  knownExternalKeys: ReadonlySet<string>;
  timezone: string;
}

/** 把抓取到的课表 + 用户设置，换算成「每个条目落在哪一天几点」。纯函数，便于单测。 */
export function buildPreview({
  timetable,
  settings,
  knownExternalKeys,
  timezone,
}: BuildPreviewInput): CoursePreview {
  const warnings: string[] = [];

  // 学期第一周周一：用户配置优先；否则用表头给出的当周周一
  const headerMonday = timetable.weekDates
    .map((item) => item.dateKey)
    .filter((key) => DATE_KEY.test(key))
    .sort()[0];
  const explicitStart =
    settings.termStartDate && DATE_KEY.test(settings.termStartDate) ? settings.termStartDate : null;
  const termStartMonday = explicitStart ?? (headerMonday ? mondayOf(headerMonday) : mondayOf(toDateKey(new Date(), timezone)));
  const termStartInferred = explicitStart === null;

  if (termStartInferred) {
    warnings.push(
      `学校系统只提供当周日期（${headerMonday ?? '未知'}），无法得知学程第一周。已暂按 ${termStartMonday} 作为第一周周一生成，请在下方按实际开学日期修正。`,
    );
  }
  if (settings.fridaySeparate) {
    warnings.push('已启用「周五单独时间」：周五各节次使用你配置的独立时间表。');
  }

  const maxPeriod = timetable.periodNumbers.reduce((acc, value) => Math.max(acc, value), 0);
  const configuredMax = settings.fridaySeparate
    ? Math.max(
        settings.periods.reduce((acc, item) => Math.max(acc, item.index), 0),
        settings.fridayPeriods.reduce((acc, item) => Math.max(acc, item.index), 0),
      )
    : settings.periods.reduce((acc, item) => Math.max(acc, item.index), 0);
  if (maxPeriod > configuredMax) {
    warnings.push(
      `课表出现了第 ${maxPeriod} 节，但节次时间只配到第 ${configuredMax} 节，超出部分按每节 50 分钟顺延估算，请补充配置。`,
    );
  }

  const slots: PreviewSlot[] = [];
  let fallbackCount = 0;

  for (const slot of timetable.slots) {
    const { start, end, fallback } = resolvePeriodTime(settings, slot.weekday, slot.period);
    if (fallback) fallbackCount += 1;

    const offsetDays = slot.weekday - 1; // 周一 = 0 … 周日 = 6
    const dateKey = addDaysToDateKey(termStartMonday, offsetDays);
    const startInstant = localDateTimeToInstant(dateKey, start, timezone);
    const endInstant = localDateTimeToInstant(dateKey, end, timezone);
    const externalKey = slotExternalKey(timetable.termId, slot);

    slots.push({
      externalKey,
      weekday: slot.weekday,
      weekdayLabel: WEEKDAY_LABELS[slot.weekday] ?? `星期${slot.weekday}`,
      period: slot.period,
      courseName: slot.courseName,
      teacher: slot.teacher,
      room: slot.room,
      firstStartAt: startInstant.toISOString(),
      firstEndAt: endInstant.toISOString(),
      timeFallback: fallback,
      willUpdate: knownExternalKeys.has(externalKey),
    });
  }

  slots.sort((a, b) => a.weekday - b.weekday || a.period - b.period);

  if (fallbackCount > 0) {
    warnings.push(`有 ${fallbackCount} 个节次缺少对应时间配置，已用默认时长估算。`);
  }

  return {
    termId: timetable.termId,
    termName: timetable.termName,
    weekDates: timetable.weekDates.map((item) => ({
      weekday: item.weekday,
      weekdayLabel: WEEKDAY_LABELS[item.weekday] ?? '',
      dateKey: item.dateKey,
    })),
    periodNumbers: timetable.periodNumbers,
    slots,
    termStartDate: termStartMonday,
    totalWeeks: settings.totalWeeks,
    termStartInferred,
    warnings,
    fetchedAt: timetable.fetchedAt,
  };
}

/* ------------------------------------------------------------------ *
 * 同步记录
 * ------------------------------------------------------------------ */

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

interface SyncRunRow {
  id: number;
  source: string;
  started_at: string;
  finished_at: string | null;
  status: SyncRun['status'];
  message: string;
  created_count: number;
  updated_count: number;
  removed_count: number;
  total_count: number;
}

function toSyncRun(row: SyncRunRow): SyncRun {
  return {
    id: row.id,
    source: row.source,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    message: row.message,
    created: row.created_count,
    updated: row.updated_count,
    removed: row.removed_count,
    total: row.total_count,
  };
}

function startRun(db: SqliteDatabase): number {
  return run(db, `INSERT INTO sync_runs (source, started_at, status) VALUES (?, ?, 'running')`, [
    COURSE_SOURCE,
    nowIso(),
  ]).lastInsertRowid;
}

function finishRun(
  db: SqliteDatabase,
  id: number,
  patch: { status: 'success' | 'failed'; message?: string; created?: number; updated?: number; removed?: number; total?: number },
): void {
  run(
    db,
    `UPDATE sync_runs SET finished_at = ?, status = ?, message = ?,
       created_count = ?, updated_count = ?, removed_count = ?, total_count = ?
     WHERE id = ?`,
    [
      nowIso(),
      patch.status,
      patch.message ?? '',
      patch.created ?? 0,
      patch.updated ?? 0,
      patch.removed ?? 0,
      patch.total ?? 0,
      id,
    ],
  );
}

export function latestSyncRun(db: SqliteDatabase): SyncRun | null {
  const row = get<SyncRunRow>(
    db,
    'SELECT * FROM sync_runs WHERE source = ? ORDER BY id DESC LIMIT 1',
    [COURSE_SOURCE],
  );
  return row ? toSyncRun(row) : null;
}

/* ------------------------------------------------------------------ *
 * 映射表
 * ------------------------------------------------------------------ */

interface SlotLinkRow {
  external_key: string;
  event_id: number;
  title: string;
}

function listSlotLinks(db: SqliteDatabase): SlotLinkRow[] {
  return all<SlotLinkRow>(
    db,
    'SELECT external_key, event_id, title FROM course_slot_links WHERE source = ?',
    [COURSE_SOURCE],
  );
}

function upsertSlotLink(
  db: SqliteDatabase,
  externalKey: string,
  eventId: number,
  title: string,
): void {
  run(
    db,
    `INSERT INTO course_slot_links (source, external_key, event_id, title, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (source, external_key) DO UPDATE SET
       event_id = excluded.event_id, title = excluded.title, updated_at = excluded.updated_at`,
    [COURSE_SOURCE, externalKey, eventId, title, nowIso()],
  );
}

function deleteSlotLink(db: SqliteDatabase, externalKey: string): void {
  run(db, 'DELETE FROM course_slot_links WHERE source = ? AND external_key = ?', [
    COURSE_SOURCE,
    externalKey,
  ]);
}

/* ------------------------------------------------------------------ *
 * 分类
 * ------------------------------------------------------------------ */

function ensureCourseCategory(db: SqliteDatabase, settings: CourseSyncSettings): number {
  const existing = listCategories(db);
  if (settings.categoryId !== null) {
    const hit = existing.find((category) => category.id === settings.categoryId);
    if (hit) return hit.id;
  }
  const named = existing.find((category) => category.name === CATEGORY_NAME);
  if (named) {
    writeCourseSyncSettings(db, { categoryId: named.id });
    return named.id;
  }
  const created = createCategory({ name: CATEGORY_NAME, color: CATEGORY_COLOR, icon: 'book-open' }, db);
  writeCourseSyncSettings(db, { categoryId: created.id });
  return created.id;
}

/* ------------------------------------------------------------------ *
 * 抓取 → 预览
 * ------------------------------------------------------------------ */

export interface PreviewOptions {
  fetcher?: TimetableFetcher;
  credentials?: SchoolCredentials;
  db?: SqliteDatabase;
  /** 跳过网络，直接对给定 HTML 做预览（用于测试与排查） */
  rawHtml?: string;
}

function resolveCredentials(db: SqliteDatabase, override?: SchoolCredentials): SchoolCredentials {
  if (override && override.username.trim().length > 0 && override.password.length > 0) return override;
  const stored = readCredentials(db);
  if (!stored) {
    throw new ValidationError('尚未保存学校系统账号密码，请先在「课程同步」里填写', {
      hint: '也可以在本次请求里带上 username / password 临时使用，不落库',
    });
  }
  return { username: stored.username, password: stored.password };
}

export async function previewCourses(options: PreviewOptions = {}): Promise<CoursePreview> {
  const db = options.db ?? getDatabase();
  const settings = readCourseSyncSettings(db);
  const timezone = systemTimeZone();

  let timetable: SchoolTimetable;
  try {
    if (options.rawHtml !== undefined) {
      timetable = buildTimetable(settings.baseUrl, options.rawHtml, nowIso());
    } else {
      const credentials = resolveCredentials(db, options.credentials);
      const fetcher = options.fetcher ?? defaultFetcher;
      const raw: TimetableFetchResult = await fetcher(credentials, settings.baseUrl);
      timetable = buildTimetable(raw.baseUrl, raw.html, raw.fetchedAt);
    }
  } catch (error) {
    // 网络、登录与解析错误都要翻译成可操作的 4xx，而不是漏成 500
    translatePortalError(error);
    throw error;
  }

  const known = new Set(listSlotLinks(db).map((link) => link.external_key));
  return buildPreview({ timetable, settings, knownExternalKeys: known, timezone });
}

/* ------------------------------------------------------------------ *
 * 导入
 * ------------------------------------------------------------------ */

export interface ImportResult extends CoursePreview {
  created: number;
  updated: number;
  removed: number;
  categoryId: number;
}

function describeEvent(slot: PreviewSlot, settings: CourseSyncSettings): string {
  const lines: string[] = [];
  if (settings.includeTeacher && slot.teacher) lines.push(`教师：${slot.teacher}`);
  if (settings.includeRoom && slot.room) lines.push(`教室：${slot.room}`);
  lines.push(`节次：第 ${slot.period} 节（${slot.weekdayLabel}）`);
  lines.push('由学校课表自动同步，手动修改条目内容会在下次同步时被覆盖。');
  return lines.join('\n');
}

function recurrenceFor(preview: CoursePreview): RecurrenceRule {
  const termEnd = addDaysToDateKey(preview.termStartDate, preview.totalWeeks * 7 - 1);
  return { freq: 'WEEKLY', interval: 1, until: termEnd };
}

/** 执行一次导入。整段写在事务里，失败不会留下半套数据。 */
export async function importCourses(options: PreviewOptions = {}): Promise<ImportResult> {
  const db = options.db ?? getDatabase();
  const runId = startRun(db);

  try {
    const preview = await previewCourses(options);
    const settings = readCourseSyncSettings(db);
    const timezone = systemTimeZone();
    const rule = recurrenceFor(preview);
    const existingLinks = new Map(listSlotLinks(db).map((link) => [link.external_key, link]));

    let created = 0;
    let updated = 0;
    let removed = 0;

    transaction(db, () => {
      const categoryId = ensureCourseCategory(db, settings);
      const seen = new Set<string>();

      for (const slot of preview.slots) {
        seen.add(slot.externalKey);
        const payload = {
          title: slot.courseName,
          description: describeEvent(slot, settings),
          location: settings.includeRoom ? slot.room : '',
          categoryId,
          priority: 'normal' as const,
          status: 'confirmed' as const,
          allDay: false,
          startAt: slot.firstStartAt,
          endAt: slot.firstEndAt,
          timezone,
          tags: ['课程'],
          rrule: rule,
          color: null,
          remindMinutesBefore: 10,
        };

        const link = existingLinks.get(slot.externalKey);
        if (link) {
          const current: EventRecord | null = tryGetEvent(db, link.event_id);
          if (current) {
            updateEvent(link.event_id, payload, db);
            upsertSlotLink(db, slot.externalKey, link.event_id, slot.courseName);
            updated += 1;
            continue;
          }
          // 映射指向的日程已被手动删除，按新建处理
          deleteSlotLink(db, slot.externalKey);
        }

        const event = createEvent(payload, db);
        upsertSlotLink(db, slot.externalKey, event.id, slot.courseName);
        created += 1;
      }

      // 课表里已经消失的条目：删除对应日程与映射
      for (const link of existingLinks.values()) {
        if (seen.has(link.external_key)) continue;
        deleteSlotLink(db, link.external_key);
        tryDeleteEvent(db, link.event_id);
        removed += 1;
      }
    });

    finishRun(db, runId, {
      status: 'success',
      message: `${preview.termName ?? '未知学程'}：新建 ${created}、更新 ${updated}、删除 ${removed}`,
      created,
      updated,
      removed,
      total: preview.slots.length,
    });

    logger.info('课程同步完成', { created, updated, removed, term: preview.termName });

    return {
      ...preview,
      created,
      updated,
      removed,
      categoryId: readCourseSyncSettings(db).categoryId ?? 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishRun(db, runId, { status: 'failed', message });
    // 用户可修复的问题（账号错、未排课、网络不通）记为 warn；真正的内部异常才是 error
    if (error instanceof AppError && error.status < 500) {
      logger.warn('课程同步未完成', { reason: message });
    } else {
      logger.error('课程同步失败', error);
    }
    throw error;
  }
}

function tryGetEvent(db: SqliteDatabase, id: number): EventRecord | null {
  try {
    return getEvent(id, db);
  } catch {
    return null;
  }
}

function tryDeleteEvent(db: SqliteDatabase, id: number): void {
  try {
    run(db, 'DELETE FROM events WHERE id = ?', [id]);
  } catch (error) {
    logger.warn('删除课程日程失败', { eventId: id, error: String(error) });
  }
}

/* ------------------------------------------------------------------ *
 * 状态汇总
 * ------------------------------------------------------------------ */

export interface CourseSyncStatus {
  credentials: ReturnType<typeof describeCredentials>;
  settings: CourseSyncSettings;
  lastRun: SyncRun | null;
  linkedCount: number;
  autoSyncEnabled: boolean;
  schedulerIntervalMs: number;
  serverTime: string;
}

export function courseSyncStatus(db: SqliteDatabase = getDatabase()): CourseSyncStatus {
  const settings = readCourseSyncSettings(db);
  const row = get<{ count: number }>(
    db,
    'SELECT COUNT(*) AS count FROM course_slot_links WHERE source = ?',
    [COURSE_SOURCE],
  );
  return {
    credentials: describeCredentials(db),
    settings,
    lastRun: latestSyncRun(db),
    linkedCount: Number(row?.count ?? 0),
    autoSyncEnabled: settings.autoSync,
    schedulerIntervalMs: settings.syncIntervalHours * 3_600_000,
    serverTime: nowIso(),
  };
}

/* ------------------------------------------------------------------ *
 * 请求体校验
 * ------------------------------------------------------------------ */

export const credentialsInputSchema = z
  .object({
    username: z.string().trim().min(1, '请填写账号').max(64),
    password: z.string().min(1, '请填写密码').max(128),
    remember: z.boolean().optional(),
  })
  .strict();

export const previewInputSchema = z
  .object({
    username: z.string().trim().min(1).max(64).optional(),
    password: z.string().min(1).max(128).optional(),
    rawHtml: z.string().max(2_000_000).optional(),
  })
  .strict();

export const settingsPatchSchema = z
  .object({
    baseUrl: z.string().trim().url().max(200).optional(),
    periods: z
      .array(z.object({ index: z.number().int().min(1).max(30), start: z.string(), end: z.string() }))
      .min(1)
      .max(30)
      .optional(),
    fridaySeparate: z.boolean().optional(),
    fridayPeriods: z
      .array(z.object({ index: z.number().int().min(1).max(30), start: z.string(), end: z.string() }))
      .min(1)
      .max(30)
      .optional(),
    termStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    totalWeeks: z.number().int().min(1).max(30).optional(),
    autoSync: z.boolean().optional(),
    syncIntervalHours: z.number().int().min(1).max(168).optional(),
    includeTeacher: z.boolean().optional(),
    includeRoom: z.boolean().optional(),
    categoryId: z.number().int().positive().nullable().optional(),
  })
  .strict();

export type CredentialsInput = z.infer<typeof credentialsInputSchema>;
export type PreviewInput = z.infer<typeof previewInputSchema>;
export type SettingsPatchInput = z.infer<typeof settingsPatchSchema>;
