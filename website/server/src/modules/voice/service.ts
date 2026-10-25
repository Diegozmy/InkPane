/** 语音助手设置服务：读取完整配置、局部更新并回读。 */

import { getDatabase, type SqliteDatabase } from '../../db/client.js';
import type { VoiceUpdateInput } from '../../domain/schemas.js';
import type { VoiceSettings } from '../../domain/types.js';
import { readVoiceSettings, writeVoiceSettings } from './settings.js';

export function getVoiceSettings(
  userId: number,
  db: SqliteDatabase = getDatabase(),
): VoiceSettings {
  return readVoiceSettings(db, userId);
}

/** PUT /api/voice：局部更新后返回完整配置，前端据此刷新草稿。 */
export function updateVoiceSettings(
  input: VoiceUpdateInput,
  userId: number,
  db: SqliteDatabase = getDatabase(),
): VoiceSettings {
  writeVoiceSettings(db, userId, input);
  return readVoiceSettings(db, userId);
}
