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
  writeRefreshMinutes,
} from './settings.js';

export function getDisplayConfig(db: SqliteDatabase = getDatabase()): DisplayConfig {
  const settings = readDisplaySettings(db);
  return {
    layout: settings.layout,
    refreshMinutes: settings.refreshMinutes,
    modules: [...MODULE_CATALOG],
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
  };
}

/** PUT /api/display：layout 整体覆盖（updatedAt 服务端刷新），refreshMinutes 单独覆盖。 */
export function updateDisplayConfig(
  input: DisplayUpdateInput,
  db: SqliteDatabase = getDatabase(),
): DisplayConfig {
  if (input.layout) {
    // 入参里的 updatedAt 只用于兼容前端回传，实际写入服务端当前时间
    writeDisplayLayout(db, input.layout.modules);
  }
  if (input.refreshMinutes !== undefined) {
    writeRefreshMinutes(db, input.refreshMinutes);
  }
  return getDisplayConfig(db);
}
