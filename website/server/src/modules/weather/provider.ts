/**
 * Open-Meteo 数据源。
 *
 * 只负责「取数 + 映射成领域结构」，网络的失败与回退策略在 service 层处理：
 * provider 出错就抛异常，由 service 决定返回缓存还是回退快照，绝不把错误抛给客户端。
 *
 * 测试通过 setWeatherFetchForTests() 注入假 fetch，因此这里不直接依赖 undici。
 */

import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { addDaysToDateKey, isValidTimeZone, wallTimeToInstant } from '../../domain/time.js';
import { weekdayLabelOfDateKey } from '../../domain/display-time.js';
import type {
  WeatherCurrent,
  WeatherForecastDay,
  WeatherIcon,
  WeatherSearchResult,
  WeatherToday,
} from '../../domain/types.js';

export const WEATHER_FETCH_TIMEOUT_MS = 6_000;
export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
/** 设备屏幕固定展示含今天在内的 3 天预报 */
export const FORECAST_DAYS = 3;

export interface WeatherFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type WeatherFetch = (url: string, init: { signal: AbortSignal }) => Promise<WeatherFetchResponse>;

let fetchOverride: WeatherFetch | null = null;

/** 测试专用：传入 fake fetch；传 null 恢复使用全局 fetch。 */
export function setWeatherFetchForTests(impl: WeatherFetch | null): void {
  fetchOverride = impl;
}

function activeFetch(): WeatherFetch {
  if (fetchOverride) return fetchOverride;
  return async (url, init) => {
    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json() as Promise<unknown>,
    };
  };
}

/* ------------------------------------------------------------------ *
 * WMO 天气代码 → 中文描述 + 图标
 * ------------------------------------------------------------------ */

export function mapWeatherCode(code: number): { condition: string; icon: WeatherIcon } {
  if (code === 0) return { condition: '晴', icon: 'clear' };
  if (code >= 1 && code <= 2) return { condition: '多云', icon: 'partly-cloudy' };
  if (code === 3) return { condition: '阴', icon: 'cloudy' };
  if (code === 45 || code === 48) return { condition: '雾', icon: 'fog' };
  if (code >= 51 && code <= 57) return { condition: '毛毛雨', icon: 'drizzle' };
  if (code >= 61 && code <= 67) return { condition: '雨', icon: 'rain' };
  if (code >= 71 && code <= 77) return { condition: '雪', icon: 'snow' };
  if (code >= 80 && code <= 82) return { condition: '阵雨', icon: 'rain' };
  if (code >= 85 && code <= 86) return { condition: '阵雪', icon: 'snow' };
  if (code >= 95 && code <= 99) return { condition: '雷阵雨', icon: 'thunderstorm' };
  return { condition: '未知', icon: 'cloudy' };
}

/* ------------------------------------------------------------------ *
 * 响应结构校验
 * ------------------------------------------------------------------ */

const numberArray = z.array(z.number());

const openMeteoResponseSchema = z.object({
  timezone: z.string().optional(),
  current: z.object({
    time: z.string().optional(),
    temperature_2m: z.number(),
    relative_humidity_2m: z.number(),
    apparent_temperature: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
    is_day: z.number().optional(),
  }),
  daily: z.object({
    time: z.array(z.string()).min(1),
    weather_code: numberArray,
    temperature_2m_max: numberArray,
    temperature_2m_min: numberArray,
    precipitation_probability_max: z.array(z.number().nullable()).optional(),
  }),
});

const geocodingResponseSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        admin1: z.string().optional(),
        country: z.string().optional(),
        latitude: z.number(),
        longitude: z.number(),
        timezone: z.string().optional(),
      }),
    )
    .optional(),
});

export interface WeatherLocation {
  city: string;
  latitude: number;
  longitude: number;
}

export interface WeatherPayload {
  observedAt: string;
  current: WeatherCurrent;
  today: WeatherToday;
  forecast: WeatherForecastDay[];
}

/* ------------------------------------------------------------------ *
 * 网络请求
 * ------------------------------------------------------------------ */

async function requestJson(url: string): Promise<unknown> {
  const doFetch = activeFetch();
  // 6 秒超时：上游变慢时尽快回退，避免墨水屏拉取被拖住
  const response = await doFetch(url, { signal: AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`天气服务返回 HTTP ${response.status}`);
  return response.json();
}

function buildForecastUrl(location: WeatherLocation): string {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', String(location.latitude));
  url.searchParams.set('longitude', String(location.longitude));
  url.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day',
  );
  url.searchParams.set(
    'daily',
    'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  );
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', String(FORECAST_DAYS));
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * 映射
 * ------------------------------------------------------------------ */

function at(list: readonly number[], index: number, fallback: number): number {
  const value = list[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function precipitationAt(list: readonly (number | null)[] | undefined, index: number): number {
  const value = list?.[index];
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Open-Meteo 的时间字段默认返回「当地时间且不带偏移」（如 2026-10-18T19:00），
 * 直接 new Date() 会被当成本机时区，因此这里按响应里的 timezone 换算成 UTC 瞬间。
 */
function observedAtFrom(raw: string | undefined, timeZone: string, fallback: string): string {
  if (!raw) return fallback;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match) return fallback;
  const [, year, month, day, hour, minute, second] = match;
  if (!year || !month || !day || !hour || !minute) return fallback;
  const instant = wallTimeToInstant(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: second ? Number(second) : 0,
    },
    timeZone,
  );
  return Number.isNaN(instant.getTime()) ? fallback : instant.toISOString();
}

function buildForecastDays(
  daily: z.infer<typeof openMeteoResponseSchema>['daily'],
  count: number,
): WeatherForecastDay[] {
  const days: WeatherForecastDay[] = [];
  for (let index = 0; index < count; index += 1) {
    const date = daily.time[index];
    if (typeof date !== 'string') break;
    const mapping = mapWeatherCode(at(daily.weather_code, index, 0));
    days.push({
      date,
      weekday: weekdayLabelOfDateKey(date),
      min: at(daily.temperature_2m_min, index, 0),
      max: at(daily.temperature_2m_max, index, 0),
      condition: mapping.condition,
      icon: mapping.icon,
      precipitationProbability: precipitationAt(daily.precipitation_probability_max, index),
    });
  }

  // 正常情况上游会给满 forecast_days 天；缺天时按最后一天顺延补足，保证结构稳定
  while (days.length < count) {
    const previous = days[days.length - 1];
    if (!previous) break;
    const date = addDaysToDateKey(previous.date, 1);
    days.push({ ...previous, date, weekday: weekdayLabelOfDateKey(date) });
  }
  return days;
}

/* ------------------------------------------------------------------ *
 * 对外取数
 * ------------------------------------------------------------------ */

/** 拉取并映射当前天气 + 3 天预报；失败时抛异常，由 service 统一回退。 */
export async function fetchWeatherPayload(
  location: WeatherLocation,
  fallbackTimeZone = 'Asia/Shanghai',
): Promise<WeatherPayload> {
  const raw = await requestJson(buildForecastUrl(location));
  const parsed = openMeteoResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error('天气服务返回的数据结构不符合预期');

  const data = parsed.data;
  const timeZone =
    data.timezone && isValidTimeZone(data.timezone) ? data.timezone : fallbackTimeZone;
  const fetchedAt = new Date().toISOString();
  const observedAt = observedAtFrom(data.current.time, timeZone, fetchedAt);
  const currentMapping = mapWeatherCode(data.current.weather_code);

  const current: WeatherCurrent = {
    temperature: data.current.temperature_2m,
    apparentTemperature: data.current.apparent_temperature,
    humidity: data.current.relative_humidity_2m,
    weatherCode: data.current.weather_code,
    condition: currentMapping.condition,
    icon: currentMapping.icon,
    windSpeed: data.current.wind_speed_10m,
    isDay: (data.current.is_day ?? 1) === 1,
  };

  const forecast = buildForecastDays(data.daily, FORECAST_DAYS);
  const first = forecast[0];
  if (!first) throw new Error('天气服务未返回任何预报日');

  const today: WeatherToday = {
    date: first.date,
    min: first.min,
    max: first.max,
    precipitationProbability: first.precipitationProbability,
    condition: first.condition,
    icon: first.icon,
  };

  return { observedAt, current, today, forecast };
}

export interface WeatherSearchOutcome {
  results: WeatherSearchResult[];
  warning?: string;
}

/** 城市搜索；网络/结构异常返回空结果 + 提示，不向上抛错。 */
export async function searchCities(query: string): Promise<WeatherSearchOutcome> {
  const url = new URL(GEOCODING_URL);
  url.searchParams.set('name', query);
  url.searchParams.set('count', '8');
  url.searchParams.set('language', 'zh');
  url.searchParams.set('format', 'json');

  try {
    const raw = await requestJson(url.toString());
    const parsed = geocodingResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return { results: [], warning: '城市搜索返回的数据结构无法解析' };
    }
    const results: WeatherSearchResult[] = (parsed.data.results ?? []).map((item) => ({
      name: item.name,
      admin1: item.admin1 ?? '',
      country: item.country ?? '',
      latitude: item.latitude,
      longitude: item.longitude,
      timezone: item.timezone ?? '',
    }));
    return { results };
  } catch (error) {
    logger.warn('城市搜索失败', { error: String(error) });
    return { results: [], warning: '城市搜索暂时不可用，请检查网络后重试' };
  }
}
