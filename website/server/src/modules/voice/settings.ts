/**
 * 语音助手设置的读写。
 *
 * 与显示布局一样按用户存在 app_settings（键前缀 `voice.`），同一账号的所有设备共用。
 * 读取时对每一项都做一次容错：配置缺失、JSON 损坏或取值越界时回退默认值，
 * 保证设备拉屏永远能拿到一份结构完整、可直接下发给语音模块的配置。
 */

import type { SqliteDatabase } from '../../db/client.js';
import { readJsonSetting, readSetting, writeSetting } from '../../lib/app-settings.js';
import { VOICE_WAKE_WORD_PATTERN, type VoiceUpdateInput } from '../../domain/schemas.js';
import type { VoiceSettings } from '../../domain/types.js';

export const DEFAULT_VOICE_OTA_URL = 'https://api.tenclass.net/xiaozhi/ota/';
export const DEFAULT_WAKE_WORDS: readonly string[] = ['你好小智'];
export const DEFAULT_WAKE_THRESHOLD = 65;
export const DEFAULT_VOLUME = 60;

export const WAKE_WORDS_MIN = 1;
export const WAKE_WORDS_MAX = 8;

const KEY_ENABLED = 'voice.enabled';
const KEY_ALLOW_CONTROL = 'voice.allowControl';
const KEY_OTA_URL = 'voice.otaUrl';
const KEY_WAKE_WORDS = 'voice.wakeWords';
const KEY_WAKE_THRESHOLD = 'voice.wakeThreshold';
const KEY_VOLUME = 'voice.volume';

/** 该用户语音设置涉及的全部 app_settings 键（文档与测试用）。 */
export const VOICE_SETTING_KEYS = [
  KEY_ENABLED,
  KEY_ALLOW_CONTROL,
  KEY_OTA_URL,
  KEY_WAKE_WORDS,
  KEY_WAKE_THRESHOLD,
  KEY_VOLUME,
] as const;

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: true,
  allowControl: true,
  otaUrl: DEFAULT_VOICE_OTA_URL,
  wakeWords: [...DEFAULT_WAKE_WORDS],
  wakeThreshold: DEFAULT_WAKE_THRESHOLD,
  volume: DEFAULT_VOLUME,
};

function readBoolean(db: SqliteDatabase, userId: number, key: string, fallback: boolean): boolean {
  const raw = readSetting(db, userId, key)?.trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

function readIntInRange(
  db: SqliteDatabase,
  userId: number,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = readSetting(db, userId, key)?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function readOtaUrl(db: SqliteDatabase, userId: number): string {
  const raw = readSetting(db, userId, KEY_OTA_URL)?.trim();
  if (!raw || raw.length > 200) return DEFAULT_VOICE_OTA_URL;
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:') return raw;
  } catch {
    // 落库值损坏时回退默认地址，避免设备拿到无法解析的 URL
  }
  return DEFAULT_VOICE_OTA_URL;
}

/** 读取唤醒词：过滤非法项、去重、截断到上限；空结果回退默认唤醒词。 */
function readWakeWords(db: SqliteDatabase, userId: number): string[] {
  const parsed = readJsonSetting(db, userId, KEY_WAKE_WORDS);
  if (!Array.isArray(parsed)) return [...DEFAULT_WAKE_WORDS];
  const words = parsed
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => VOICE_WAKE_WORD_PATTERN.test(item));
  const unique = [...new Set(words)].slice(0, WAKE_WORDS_MAX);
  return unique.length >= WAKE_WORDS_MIN ? unique : [...DEFAULT_WAKE_WORDS];
}

export function readVoiceSettings(db: SqliteDatabase, userId: number): VoiceSettings {
  return {
    enabled: readBoolean(db, userId, KEY_ENABLED, DEFAULT_VOICE_SETTINGS.enabled),
    allowControl: readBoolean(db, userId, KEY_ALLOW_CONTROL, DEFAULT_VOICE_SETTINGS.allowControl),
    otaUrl: readOtaUrl(db, userId),
    wakeWords: readWakeWords(db, userId),
    wakeThreshold: readIntInRange(db, userId, KEY_WAKE_THRESHOLD, DEFAULT_WAKE_THRESHOLD, 0, 100),
    volume: readIntInRange(db, userId, KEY_VOLUME, DEFAULT_VOLUME, 0, 100),
  };
}

/** 局部写入：只覆盖入参里出现的键，其余保留原值。 */
export function writeVoiceSettings(
  db: SqliteDatabase,
  userId: number,
  input: VoiceUpdateInput,
): void {
  if (input.enabled !== undefined) {
    writeSetting(db, userId, KEY_ENABLED, String(input.enabled));
  }
  if (input.allowControl !== undefined) {
    writeSetting(db, userId, KEY_ALLOW_CONTROL, String(input.allowControl));
  }
  if (input.otaUrl !== undefined) {
    writeSetting(db, userId, KEY_OTA_URL, input.otaUrl);
  }
  if (input.wakeWords !== undefined) {
    writeSetting(db, userId, KEY_WAKE_WORDS, JSON.stringify(input.wakeWords));
  }
  if (input.wakeThreshold !== undefined) {
    writeSetting(db, userId, KEY_WAKE_THRESHOLD, String(input.wakeThreshold));
  }
  if (input.volume !== undefined) {
    writeSetting(db, userId, KEY_VOLUME, String(input.volume));
  }
}
