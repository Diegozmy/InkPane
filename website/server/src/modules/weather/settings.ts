/**
 * 天气设置读写。
 *
 * 城市、经纬度与开关都按契约使用独立键（weather.city / weather.latitude / …），
 * 首次读取时把缺省键落库，保证 updatedAt 稳定、GET 结果可重复。
 */

import type { SqliteDatabase } from '../../db/client.js';
import {
  latestSettingUpdate,
  readSetting,
  readSettingRow,
  writeSetting,
} from '../../lib/app-settings.js';
import { nowIso } from '../../lib/clock.js';
import type { WeatherSettingsView } from '../../domain/types.js';
import { readDisplayTimezone } from '../display/settings.js';

export const DEFAULT_WEATHER_SETTINGS = {
  city: '上海',
  latitude: 31.2304,
  longitude: 121.4737,
  enabled: true,
} as const;

const KEYS = {
  city: 'weather.city',
  latitude: 'weather.latitude',
  longitude: 'weather.longitude',
  enabled: 'weather.enabled',
} as const;

const ALL_KEYS = [KEYS.city, KEYS.latitude, KEYS.longitude, KEYS.enabled] as const;

export interface WeatherSettings {
  city: string;
  latitude: number;
  longitude: number;
  enabled: boolean;
  updatedAt: string;
}

function parseCoordinate(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

/** 读取设置，顺带补齐缺失的默认键。 */
export function readWeatherSettings(db: SqliteDatabase): WeatherSettings {
  const missing = ALL_KEYS.filter((key) => readSettingRow(db, key) === null);
  const defaults: Record<(typeof ALL_KEYS)[number], string> = {
    [KEYS.city]: DEFAULT_WEATHER_SETTINGS.city,
    [KEYS.latitude]: String(DEFAULT_WEATHER_SETTINGS.latitude),
    [KEYS.longitude]: String(DEFAULT_WEATHER_SETTINGS.longitude),
    [KEYS.enabled]: DEFAULT_WEATHER_SETTINGS.enabled ? 'true' : 'false',
  };
  for (const key of missing) {
    writeSetting(db, key, defaults[key]);
  }

  const cityRaw = readSetting(db, KEYS.city)?.trim();
  const enabledRaw = readSetting(db, KEYS.enabled);

  return {
    city: cityRaw && cityRaw.length > 0 ? cityRaw : DEFAULT_WEATHER_SETTINGS.city,
    latitude: parseCoordinate(
      readSetting(db, KEYS.latitude),
      -90,
      90,
      DEFAULT_WEATHER_SETTINGS.latitude,
    ),
    longitude: parseCoordinate(
      readSetting(db, KEYS.longitude),
      -180,
      180,
      DEFAULT_WEATHER_SETTINGS.longitude,
    ),
    enabled: enabledRaw === null ? DEFAULT_WEATHER_SETTINGS.enabled : enabledRaw === 'true',
    updatedAt: latestSettingUpdate(db, ALL_KEYS) ?? nowIso(),
  };
}

export interface WeatherSettingsPatch {
  city?: string;
  latitude?: number;
  longitude?: number;
  enabled?: boolean;
}

export function writeWeatherSettings(
  db: SqliteDatabase,
  patch: WeatherSettingsPatch,
): WeatherSettings {
  if (patch.city !== undefined) writeSetting(db, KEYS.city, patch.city);
  if (patch.latitude !== undefined) writeSetting(db, KEYS.latitude, String(patch.latitude));
  if (patch.longitude !== undefined) writeSetting(db, KEYS.longitude, String(patch.longitude));
  if (patch.enabled !== undefined) {
    writeSetting(db, KEYS.enabled, patch.enabled ? 'true' : 'false');
  }
  return readWeatherSettings(db);
}

/** 对外返回的形状：额外带上显示时区，方便前端判断「今天」。 */
export function weatherSettingsView(db: SqliteDatabase): WeatherSettingsView {
  const settings = readWeatherSettings(db);
  return {
    city: settings.city,
    latitude: settings.latitude,
    longitude: settings.longitude,
    enabled: settings.enabled,
    timezone: readDisplayTimezone(db),
    updatedAt: settings.updatedAt,
  };
}
