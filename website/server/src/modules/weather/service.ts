/**
 * 天气服务：缓存、刷新与回退策略都集中在这一层。
 *
 * 契约要点：
 * - 缓存 TTL 15 分钟，命中时直接返回 source = 'cache'；
 * - 过期后尝试联网，成功返回 source = 'open-meteo' 并更新缓存；
 * - 联网失败时退回上次缓存（stale = true），从未成功过则返回 fallback 快照；
 * - 任何情况下都不向客户端抛 500。
 */

import { getDatabase, type SqliteDatabase } from '../../db/client.js';
import { get, run } from '../../db/query.js';
import { logger } from '../../lib/logger.js';
import { nowIso } from '../../lib/clock.js';
import { addDaysToDateKey } from '../../domain/time.js';
import { todayDateKey, weekdayLabelOfDateKey } from '../../domain/display-time.js';
import type { WeatherForecastDay, WeatherSnapshot } from '../../domain/types.js';
import { readDisplayTimezone } from '../display/settings.js';
import { fetchWeatherPayload, searchCities, type WeatherSearchOutcome } from './provider.js';
import { readWeatherSettings, type WeatherSettings } from './settings.js';

export const WEATHER_CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_ID = 1;
const EMPTY_CONDITION = '暂无数据';

interface WeatherCacheRow {
  payload: string;
  fetched_at: string;
}

/* ------------------------------------------------------------------ *
 * 缓存读写
 * ------------------------------------------------------------------ */

function readCachedSnapshot(db: SqliteDatabase): WeatherSnapshot | null {
  const row = get<WeatherCacheRow>(
    db,
    'SELECT payload, fetched_at FROM weather_cache WHERE id = ?',
    [CACHE_ID],
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload) as Partial<WeatherSnapshot> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.current || !parsed.today || !Array.isArray(parsed.forecast)) return null;
    return {
      ...(parsed as WeatherSnapshot),
      // fetched_at 列是 TTL 的唯一依据：缓存内容里的同名字段仅作冗余
      fetchedAt: row.fetched_at,
    };
  } catch {
    return null;
  }
}

function writeCachedSnapshot(db: SqliteDatabase, snapshot: WeatherSnapshot): void {
  run(
    db,
    `INSERT INTO weather_cache (id, payload, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
    [CACHE_ID, JSON.stringify(snapshot), snapshot.fetchedAt],
  );
}

/** 清空缓存：修改城市/开关后立即失效，下次请求重新联网。 */
export function clearWeatherCache(db: SqliteDatabase = getDatabase()): void {
  run(db, 'DELETE FROM weather_cache WHERE id = ?', [CACHE_ID]);
}

export function isCacheFresh(fetchedAt: string, nowMs: number = Date.now()): boolean {
  const fetchedMs = new Date(fetchedAt).getTime();
  if (Number.isNaN(fetchedMs)) return false;
  return nowMs - fetchedMs < WEATHER_CACHE_TTL_MS;
}

/* ------------------------------------------------------------------ *
 * 快照构造
 * ------------------------------------------------------------------ */

function fallbackSnapshot(
  settings: WeatherSettings,
  timeZone: string,
  message: string,
): WeatherSnapshot {
  const timestamp = nowIso();
  const today = todayDateKey(timeZone);
  const forecast: WeatherForecastDay[] = Array.from({ length: 3 }, (_value, index) => {
    const date = addDaysToDateKey(today, index);
    return {
      date,
      weekday: weekdayLabelOfDateKey(date),
      min: 0,
      max: 0,
      condition: EMPTY_CONDITION,
      icon: 'clear',
      precipitationProbability: 0,
    };
  });

  return {
    provider: 'open-meteo',
    city: settings.city,
    latitude: settings.latitude,
    longitude: settings.longitude,
    observedAt: timestamp,
    fetchedAt: timestamp,
    stale: true,
    source: 'fallback',
    message,
    current: {
      temperature: 0,
      apparentTemperature: 0,
      humidity: 0,
      weatherCode: 0,
      condition: EMPTY_CONDITION,
      icon: 'clear',
      windSpeed: 0,
      isDay: true,
    },
    today: {
      date: today,
      min: 0,
      max: 0,
      precipitationProbability: 0,
      condition: EMPTY_CONDITION,
      icon: 'clear',
    },
    forecast,
  };
}

/** 联网刷新；失败返回 null，由调用方决定缓存/回退。 */
async function refreshFromNetwork(
  db: SqliteDatabase,
  settings: WeatherSettings,
  timeZone: string,
): Promise<WeatherSnapshot | null> {
  try {
    const payload = await fetchWeatherPayload(
      { city: settings.city, latitude: settings.latitude, longitude: settings.longitude },
      timeZone,
    );
    const snapshot: WeatherSnapshot = {
      provider: 'open-meteo',
      city: settings.city,
      latitude: settings.latitude,
      longitude: settings.longitude,
      observedAt: payload.observedAt,
      fetchedAt: nowIso(),
      stale: false,
      source: 'open-meteo',
      current: payload.current,
      today: payload.today,
      forecast: payload.forecast,
    };
    writeCachedSnapshot(db, snapshot);
    return snapshot;
  } catch (error) {
    logger.warn('天气数据刷新失败', { error: String(error) });
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

function cachedResponse(cached: WeatherSnapshot, message: string): WeatherSnapshot {
  return { ...cached, stale: true, source: 'cache', message };
}

/** GET /api/weather：命中缓存直接返回，过期则尝试刷新。 */
export async function getWeatherSnapshot(db: SqliteDatabase = getDatabase()): Promise<WeatherSnapshot> {
  const settings = readWeatherSettings(db);
  const timeZone = readDisplayTimezone(db);
  const cached = readCachedSnapshot(db);

  if (cached && isCacheFresh(cached.fetchedAt)) {
    return { ...cached, stale: false, source: 'cache' };
  }

  const refreshed = await refreshFromNetwork(db, settings, timeZone);
  if (refreshed) return refreshed;

  if (cached) return cachedResponse(cached, '天气服务暂时不可用，显示的是上次缓存');
  return fallbackSnapshot(settings, timeZone, '天气数据暂不可用，请稍后在控制台刷新重试');
}

/** POST /api/weather/refresh：强制联网，失败照样按回退规则返回。 */
export async function refreshWeatherSnapshot(
  db: SqliteDatabase = getDatabase(),
): Promise<WeatherSnapshot> {
  const settings = readWeatherSettings(db);
  const timeZone = readDisplayTimezone(db);
  const cached = readCachedSnapshot(db);

  const refreshed = await refreshFromNetwork(db, settings, timeZone);
  if (refreshed) return refreshed;

  if (cached) return cachedResponse(cached, '天气服务暂时不可用，显示的是上次缓存');
  return fallbackSnapshot(settings, timeZone, '天气数据暂不可用，请稍后在控制台刷新重试');
}

/**
 * 设备屏幕用：只读缓存，绝不联网。
 * 开关关闭或从未成功获取时返回 null（契约允许），避免屏幕拉取被网络拖慢。
 */
export function getWeatherForScreen(db: SqliteDatabase = getDatabase()): WeatherSnapshot | null {
  const settings = readWeatherSettings(db);
  if (!settings.enabled) return null;

  const cached = readCachedSnapshot(db);
  if (!cached) return null;

  if (isCacheFresh(cached.fetchedAt)) {
    return { ...cached, stale: false, source: 'cache' };
  }
  return { ...cached, stale: true, source: 'cache', message: '天气数据已过期，等待控制台刷新' };
}

/** 城市搜索；失败不抛错，返回空结果 + 提示。 */
export function searchWeatherCities(query: string): Promise<WeatherSearchOutcome> {
  return searchCities(query);
}
