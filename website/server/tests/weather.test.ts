/**
 * 天气接口测试。
 *
 * 网络层通过 setWeatherFetchForTests() 注入假 fetch，完全不访问真实 Open-Meteo：
 * 覆盖成功映射、缓存命中、缓存过期后的刷新/回退、强制刷新、城市搜索失败降级与设置读写。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { closeDatabase, getDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { createTestUser, setupTestAdmin } from './helpers/auth.js';
import { mapWeatherCode, setWeatherFetchForTests } from '../src/modules/weather/provider.js';
import { startWeatherScheduler } from '../src/modules/weather/scheduler.js';

let app: Express;
let agent: Awaited<ReturnType<typeof setupTestAdmin>>;
let fetchCalls: string[] = [];

const FORECAST_HOST = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_HOST = 'https://geocoding-api.open-meteo.com/v1/search';

/** 一份结构真实的 Open-Meteo 响应（上海，2026-10-18 周日）。 */
function sampleOpenMeteo(): Record<string, unknown> {
  return {
    latitude: 31.25,
    longitude: 121.5,
    timezone: 'Asia/Shanghai',
    current: {
      time: '2026-10-18T19:00',
      interval: 900,
      temperature_2m: 23.5,
      relative_humidity_2m: 66,
      apparent_temperature: 24.1,
      weather_code: 1,
      wind_speed_10m: 9.2,
      is_day: 0,
    },
    daily: {
      time: ['2026-10-18', '2026-10-19', '2026-10-20'],
      weather_code: [1, 61, 95],
      temperature_2m_max: [26.2, 24.8, 22.1],
      temperature_2m_min: [18.3, 17.5, 15.9],
      precipitation_probability_max: [10, 80, 60],
    },
  };
}

function mockFetchSuccess(payload: unknown): void {
  setWeatherFetchForTests(async (url) => {
    fetchCalls.push(url);
    return { ok: true, status: 200, json: async () => payload };
  });
}

function mockFetchFailure(message = 'network down'): void {
  setWeatherFetchForTests(async (url) => {
    fetchCalls.push(url);
    throw new Error(message);
  });
}

/** 按 URL 分派：预报与地理编码各自返回不同 body。 */
function mockFetchByUrl(handlers: {
  forecast: () => unknown;
  geocoding: () => unknown;
}): void {
  setWeatherFetchForTests(async (url) => {
    fetchCalls.push(url);
    if (url.startsWith(GEOCODING_HOST)) {
      return { ok: true, status: 200, json: async () => handlers.geocoding() };
    }
    return { ok: true, status: 200, json: async () => handlers.forecast() };
  });
}

beforeEach(async () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  runMigrations(db);
  setDatabaseForTesting(db);
  app = createApp();
  agent = await setupTestAdmin(app);
  fetchCalls = [];
  setWeatherFetchForTests(null);
});

afterEach(() => {
  setWeatherFetchForTests(null);
});

afterAll(() => {
  closeDatabase();
  setDatabaseForTesting(null);
  setWeatherFetchForTests(null);
});

describe('WMO 天气代码映射', () => {
  it('把代码区间映射成中文描述与图标', () => {
    expect(mapWeatherCode(0)).toEqual({ condition: '晴', icon: 'clear' });
    expect(mapWeatherCode(1).icon).toBe('partly-cloudy');
    expect(mapWeatherCode(3).icon).toBe('cloudy');
    expect(mapWeatherCode(45).icon).toBe('fog');
    expect(mapWeatherCode(53).icon).toBe('drizzle');
    expect(mapWeatherCode(65).icon).toBe('rain');
    expect(mapWeatherCode(73).icon).toBe('snow');
    expect(mapWeatherCode(81).icon).toBe('rain');
    expect(mapWeatherCode(86).icon).toBe('snow');
    expect(mapWeatherCode(97).icon).toBe('thunderstorm');
  });
});

describe('天气快照', () => {
  it('首次请求联网并映射成统一快照', async () => {
    mockFetchSuccess(sampleOpenMeteo());

    const response = await agent.get('/api/weather');
    expect(response.status).toBe(200);
    const snapshot = response.body.data;

    expect(snapshot).toMatchObject({
      provider: 'open-meteo',
      city: '上海',
      latitude: 31.2304,
      longitude: 121.4737,
      stale: false,
      source: 'open-meteo',
      observedAt: '2026-10-18T11:00:00.000Z',
    });
    expect(snapshot.message).toBeUndefined();
    expect(snapshot.current).toEqual({
      temperature: 23.5,
      apparentTemperature: 24.1,
      humidity: 66,
      weatherCode: 1,
      condition: '多云',
      icon: 'partly-cloudy',
      windSpeed: 9.2,
      isDay: false,
    });
    expect(snapshot.today).toEqual({
      date: '2026-10-18',
      min: 18.3,
      max: 26.2,
      precipitationProbability: 10,
      condition: '多云',
      icon: 'partly-cloudy',
    });
    expect(snapshot.forecast).toHaveLength(3);
    expect(snapshot.forecast.map((day: { weekday: string }) => day.weekday)).toEqual([
      '周日',
      '周一',
      '周二',
    ]);
    expect(snapshot.forecast[1]).toMatchObject({
      date: '2026-10-19',
      min: 17.5,
      max: 24.8,
      condition: '雨',
      icon: 'rain',
      precipitationProbability: 80,
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain(FORECAST_HOST);
    expect(fetchCalls[0]).toContain('latitude=31.2304');
    expect(fetchCalls[0]).toContain('longitude=121.4737');
    expect(fetchCalls[0]).toContain('forecast_days=3');
    expect(fetchCalls[0]).toContain('timezone=auto');
  });

  it('15 分钟内重复请求命中缓存，不再联网', async () => {
    mockFetchSuccess(sampleOpenMeteo());

    const first = await agent.get('/api/weather');
    expect(first.body.data.source).toBe('open-meteo');

    const second = await agent.get('/api/weather');
    expect(second.status).toBe(200);
    expect(second.body.data.source).toBe('cache');
    expect(second.body.data.stale).toBe(false);
    expect(fetchCalls).toHaveLength(1);
  });

  it('缓存过期后刷新成功，返回新数据', async () => {
    mockFetchSuccess(sampleOpenMeteo());
    await agent.get('/api/weather');

    // 直接把缓存时间改到很久以前，模拟 TTL 过期
    getDatabase()
      .prepare('UPDATE weather_cache SET fetched_at = ? WHERE user_id = (SELECT id FROM users ORDER BY id LIMIT 1)')
      .run('2000-01-01T00:00:00.000Z');

    mockFetchSuccess(sampleOpenMeteo());
    const refreshed = await agent.get('/api/weather');
    expect(refreshed.body.data.source).toBe('open-meteo');
    expect(fetchCalls).toHaveLength(2);
  });

  it('缓存过期且刷新失败时回退上次缓存并标记 stale', async () => {
    mockFetchSuccess(sampleOpenMeteo());
    await agent.get('/api/weather');

    getDatabase()
      .prepare('UPDATE weather_cache SET fetched_at = ? WHERE user_id = (SELECT id FROM users ORDER BY id LIMIT 1)')
      .run('2000-01-01T00:00:00.000Z');

    mockFetchFailure();
    const fallback = await agent.get('/api/weather');
    expect(fallback.status).toBe(200);
    expect(fallback.body.data.source).toBe('cache');
    expect(fallback.body.data.stale).toBe(true);
    expect(fallback.body.data.message).toBeTruthy();
    // 仍然返回上次缓存的业务数据
    expect(fallback.body.data.current.temperature).toBe(23.5);
    expect(fallback.body.data.forecast).toHaveLength(3);
  });

  it('从未成功获取时返回 fallback 快照，绝不 500', async () => {
    mockFetchFailure();

    const response = await agent.get('/api/weather');
    expect(response.status).toBe(200);
    const snapshot = response.body.data;
    expect(snapshot.source).toBe('fallback');
    expect(snapshot.stale).toBe(true);
    expect(snapshot.message).toBeTruthy();
    expect(snapshot.current.condition).toBe('暂无数据');
    expect(snapshot.current.temperature).toBe(0);
    expect(snapshot.today.date).toBeTruthy();
    expect(snapshot.forecast).toHaveLength(3);
  });

  it('POST /refresh 强制联网，失败时仍按回退规则返回', async () => {
    mockFetchSuccess(sampleOpenMeteo());
    await agent.get('/api/weather');
    expect(fetchCalls).toHaveLength(1);

    const forced = await agent.post('/api/weather/refresh');
    expect(forced.status).toBe(200);
    expect(forced.body.data.source).toBe('open-meteo');
    expect(fetchCalls).toHaveLength(2);

    mockFetchFailure();
    const failed = await agent.post('/api/weather/refresh');
    expect(failed.status).toBe(200);
    expect(failed.body.data.source).toBe('cache');
    expect(failed.body.data.stale).toBe(true);
    expect(failed.body.data.message).toBeTruthy();
  });
});

describe('城市搜索', () => {
  it('返回 Open-Meteo 地理编码结果', async () => {
    mockFetchByUrl({
      forecast: sampleOpenMeteo,
      geocoding: () => ({
        results: [
          {
            name: '上海',
            admin1: '上海市',
            country: '中国',
            latitude: 31.22222,
            longitude: 121.45806,
            timezone: 'Asia/Shanghai',
          },
        ],
      }),
    });

    const response = await agent.get('/api/weather/search').query({ q: '上海' });
    expect(response.status).toBe(200);
    expect(response.body.data.results).toHaveLength(1);
    expect(response.body.data.results[0]).toEqual({
      name: '上海',
      admin1: '上海市',
      country: '中国',
      latitude: 31.22222,
      longitude: 121.45806,
      timezone: 'Asia/Shanghai',
    });
    expect(response.body.meta).toBeUndefined();
    expect(fetchCalls[0]).toContain('name=');
    expect(fetchCalls[0]).toContain('count=8');
    expect(fetchCalls[0]).toContain('language=zh');
  });

  it('网络失败返回空结果与 warning 而不是 500', async () => {
    mockFetchFailure();

    const response = await agent.get('/api/weather/search').query({ q: '杭州' });
    expect(response.status).toBe(200);
    expect(response.body.data.results).toEqual([]);
    expect(response.body.meta.warning).toBeTruthy();
  });

  it('关键词为空或超长返回 422', async () => {
    expect((await agent.get('/api/weather/search')).status).toBe(422);
    expect((await agent.get('/api/weather/search').query({ q: ' ' })).status).toBe(422);
    expect(
      (await agent.get('/api/weather/search').query({ q: 'x'.repeat(51) })).status,
    ).toBe(422);
  });
});

describe('天气设置', () => {  it('返回默认城市、坐标与开关', async () => {
    const response = await agent.get('/api/weather/settings');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      city: '上海',
      latitude: 31.2304,
      longitude: 121.4737,
      enabled: true,
      timezone: 'Asia/Shanghai',
    });
    expect(new Date(response.body.data.updatedAt as string).toString()).not.toBe('Invalid Date');
  });

  it('修改设置后立即生效，并清空天气缓存', async () => {
    mockFetchSuccess(sampleOpenMeteo());
    await agent.get('/api/weather');
    expect(fetchCalls).toHaveLength(1);

    const updated = await agent
      .put('/api/weather/settings')
      .send({ city: '北京', latitude: 39.9042, longitude: 116.4074, enabled: false });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      city: '北京',
      latitude: 39.9042,
      longitude: 116.4074,
      enabled: false,
    });

    const readBack = await agent.get('/api/weather/settings');
    expect(readBack.body.data.city).toBe('北京');

    // 缓存已被清空，下一次 GET 会重新联网
    const refreshed = await agent.get('/api/weather');
    expect(refreshed.body.data.source).toBe('open-meteo');
    expect(refreshed.body.data.city).toBe('北京');
    expect(fetchCalls).toHaveLength(2);
  });

  it('坐标越界与空请求体返回 422', async () => {
    const lat = await agent.put('/api/weather/settings').send({ latitude: 100 });
    expect(lat.status).toBe(422);

    const lon = await agent.put('/api/weather/settings').send({ longitude: -181 });
    expect(lon.status).toBe(422);

    const empty = await agent.put('/api/weather/settings').send({});
    expect(empty.status).toBe(422);

    const emptyCity = await agent.put('/api/weather/settings').send({ city: '   ' });
    expect(emptyCity.status).toBe(422);
  });
});

describe('后台天气刷新调度器', () => {
  it('按用户逐个刷新：两个活跃用户各写入一份缓存（假定时器）', async () => {
    await createTestUser(agent, 'weather-user');
    mockFetchSuccess(sampleOpenMeteo());

    vi.useFakeTimers();
    let stop: (() => void) | null = null;
    try {
      stop = startWeatherScheduler();
      // 启动延时 8s 后触发第一轮 tick
      await vi.advanceTimersByTimeAsync(8_001);
      // tick 内部是异步的，再让微任务跑完
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchCalls).toHaveLength(2);
      const row = getDatabase()
        .prepare('SELECT COUNT(*) AS count FROM weather_cache')
        .get() as { count: number };
      expect(row.count).toBe(2);
    } finally {
      stop?.();
      vi.useRealTimers();
    }
  });
});
