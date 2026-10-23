/**
 * 显示设置读写：时区、刷新间隔与模块布局，按用户存在 app_settings 表。
 *
 * 布局首次读取时会懒初始化并落库，这样：
 * - GET /api/display 与设备状态里的 layoutUpdatedAt 保持稳定，不会每次请求都变；
 * - 用户没改过布局时，设备端拿到的仍是同一份默认坐标。
 */

import type { SqliteDatabase } from '../../db/client.js';
import { readJsonSetting, readSetting, readSettingRow, writeSetting } from '../../lib/app-settings.js';
import { nowIso } from '../../lib/clock.js';
import { isValidTimeZone } from '../../domain/time.js';
import type { DisplayLayout, DisplayModule } from '../../domain/types.js';
import { buildDefaultLayout, parseStoredLayout } from './layout.js';

export const DEFAULT_DISPLAY_TIMEZONE = 'Asia/Shanghai';
export const DEFAULT_REFRESH_MINUTES = 30;
export const REFRESH_MINUTES_MIN = 5;
export const REFRESH_MINUTES_MAX = 720;

const KEY_TIMEZONE = 'display.timezone';
const KEY_REFRESH_MINUTES = 'display.refreshMinutes';
const KEY_LAYOUT = 'display.layout';

export interface DisplaySettings {
  timezone: string;
  refreshMinutes: number;
  layout: DisplayLayout;
}

/** 时区缺失或非法时回退默认值，保证「今天/本周」永远能算出来。 */
export function readDisplayTimezone(db: SqliteDatabase, userId: number): string {
  const raw = readSetting(db, userId, KEY_TIMEZONE)?.trim();
  if (raw && isValidTimeZone(raw)) return raw;
  return DEFAULT_DISPLAY_TIMEZONE;
}

export function writeDisplayTimezone(db: SqliteDatabase, userId: number, timezone: string): string {
  if (!isValidTimeZone(timezone)) {
    throw new Error(`无效的时区：${timezone}`);
  }
  writeSetting(db, userId, KEY_TIMEZONE, timezone);
  return timezone;
}

export function readRefreshMinutes(db: SqliteDatabase, userId: number): number {
  const raw = readSetting(db, userId, KEY_REFRESH_MINUTES)?.trim();
  if (!raw) return DEFAULT_REFRESH_MINUTES;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < REFRESH_MINUTES_MIN || value > REFRESH_MINUTES_MAX) {
    return DEFAULT_REFRESH_MINUTES;
  }
  return value;
}

/** 读取布局；没有有效配置时写入并返回默认布局。 */
export function readDisplayLayout(db: SqliteDatabase, userId: number): DisplayLayout {
  const row = readSettingRow(db, userId, KEY_LAYOUT);
  const parsed = row ? parseStoredLayout(readJsonSetting(db, userId, KEY_LAYOUT), row.updated_at) : null;
  if (parsed) return parsed;

  const layout = buildDefaultLayout(nowIso());
  writeSetting(db, userId, KEY_LAYOUT, JSON.stringify(layout));
  return layout;
}

export function readDisplaySettings(db: SqliteDatabase, userId: number): DisplaySettings {
  return {
    timezone: readDisplayTimezone(db, userId),
    refreshMinutes: readRefreshMinutes(db, userId),
    layout: readDisplayLayout(db, userId),
  };
}

/** 整体覆盖布局；updatedAt 由服务端写入。 */
export function writeDisplayLayout(
  db: SqliteDatabase,
  userId: number,
  modules: DisplayModule[],
  updatedAt: string = nowIso(),
): DisplayLayout {
  const layout = readDisplayLayout(db, userId);
  const next: DisplayLayout = { ...layout, updatedAt, modules };
  writeSetting(db, userId, KEY_LAYOUT, JSON.stringify(next));
  return next;
}

export function writeRefreshMinutes(db: SqliteDatabase, userId: number, value: number): number {
  writeSetting(db, userId, KEY_REFRESH_MINUTES, String(value));
  return value;
}
