/** 显示设置服务：读取布局配置、整体覆盖布局与刷新间隔。 */

import { getDatabase, type SqliteDatabase } from '../../db/client.js';
import type { DisplayUpdateInput } from '../../domain/schemas.js';
import {
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  type DisplayConfig,
} from '../../domain/types.js';
import { MODULE_CATALOG } from './layout.js';
import {
  readDisplaySettings,
  writeDisplayLayout,
  writeDisplayTimezone,
  writeRefreshMinutes,
} from './settings.js';

export function getDisplayConfig(
  userId: number,
  db: SqliteDatabase = getDatabase(),
): DisplayConfig {
  const settings = readDisplaySettings(db, userId);
  return {
    layout: settings.layout,
    refreshMinutes: settings.refreshMinutes,
    timezone: settings.timezone,
    modules: [...MODULE_CATALOG],
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
  };
}

/** PUT /api/display：layout 整体覆盖（updatedAt 服务端刷新），refreshMinutes/timezone 单独覆盖。 */
export function updateDisplayConfig(
  input: DisplayUpdateInput,
  userId: number,
  db: SqliteDatabase = getDatabase(),
): DisplayConfig {
  if (input.layout) {
    // 入参里的 updatedAt 只用于兼容前端回传，实际写入服务端当前时间
    writeDisplayLayout(db, userId, input.layout.modules);
  }
  if (input.refreshMinutes !== undefined) {
    writeRefreshMinutes(db, userId, input.refreshMinutes);
  }
  if (input.timezone !== undefined) {
    writeDisplayTimezone(db, userId, input.timezone);
  }
  return getDisplayConfig(userId, db);
}
