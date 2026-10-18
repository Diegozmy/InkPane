/**
 * 屏幕布局接口测试。
 *
 * 覆盖默认布局、模块目录、整体覆盖语义、刷新间隔边界，
 * 以及契约要求的 400 VALIDATION_FAILED（越界 / 非 4 倍数 / 缺模块 / 重复模块 / 额外字段）。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { todayDateKey } from '../src/domain/display-time.js';

const TZ = 'Asia/Shanghai';

let app: Express;

interface LayoutModule {
  id: string;
  enabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  width: number;
  height: number;
  updatedAt: string;
  modules: LayoutModule[];
}

async function getDisplay(): Promise<Record<string, unknown>> {
  const response = await request(app).get('/api/display');
  expect(response.status).toBe(200);
  return response.body.data as Record<string, unknown>;
}

function rects(layout: Layout): Record<string, { x: number; y: number; w: number; h: number }> {
  const map: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const module of layout.modules) {
    map[module.id] = { x: module.x, y: module.y, w: module.w, h: module.h };
  }
  return map;
}

function cloneLayout(layout: Layout): Layout {
  return JSON.parse(JSON.stringify(layout)) as Layout;
}

beforeEach(() => {
  closeDatabase();
  const db = openDatabase(':memory:');
  runMigrations(db);
  setDatabaseForTesting(db);
  app = createApp();
});

afterAll(() => {
  closeDatabase();
  setDatabaseForTesting(null);
});

describe('默认布局', () => {
  it('返回契约规定的 6 个模块坐标与目录', async () => {
    const data = await getDisplay();
    expect(data.width).toBe(800);
    expect(data.height).toBe(480);
    expect(data.refreshMinutes).toBe(30);

    const layout = data.layout as Layout;
    expect(layout.width).toBe(800);
    expect(layout.height).toBe(480);
    expect(layout.modules).toHaveLength(6);
    expect(new Date(layout.updatedAt).toString()).not.toBe('Invalid Date');
    expect(rects(layout)).toEqual({
      clock: { x: 16, y: 16, w: 220, h: 100 },
      calendar: { x: 16, y: 128, w: 220, h: 180 },
      todos: { x: 16, y: 320, w: 220, h: 144 },
      weather: { x: 248, y: 16, w: 240, h: 288 },
      courses: { x: 248, y: 316, w: 240, h: 148 },
      schedule: { x: 500, y: 16, w: 284, h: 448 },
    });

    const catalog = data.modules as {
      id: string;
      name: string;
      description: string;
      defaultRect: { x: number; y: number; w: number; h: number };
    }[];
    expect(catalog.map((item) => item.id)).toEqual([
      'clock',
      'calendar',
      'weather',
      'schedule',
      'courses',
      'todos',
    ]);
    expect(catalog.map((item) => item.name)).toEqual([
      '时钟',
      '月历',
      '天气',
      '今日日程',
      '今日课程',
      '待办',
    ]);
    for (const item of catalog) {
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.defaultRect).toEqual(
        (rects(layout) as Record<string, { x: number; y: number; w: number; h: number }>)[item.id],
      );
    }
  });

  it('布局懒初始化后 updatedAt 保持稳定', async () => {
    const first = await getDisplay();
    const second = await getDisplay();
    expect((second.layout as Layout).updatedAt).toBe((first.layout as Layout).updatedAt);
  });
});

describe('更新布局与刷新间隔', () => {
  it('layout 整体覆盖并由服务端刷新 updatedAt', async () => {
    const before = await getDisplay();
    const layout = cloneLayout(before.layout as Layout);
    layout.modules = layout.modules.map((module) =>
      module.id === 'clock' ? { ...module, x: 24, y: 20, w: 224, h: 104, enabled: false } : module,
    );

    const response = await request(app)
      .put('/api/display')
      .send({ layout: { ...layout, updatedAt: '2000-01-01T00:00:00.000Z' }, refreshMinutes: 60 });
    expect(response.status).toBe(200);
    const data = response.body.data as Record<string, unknown>;
    expect(data.refreshMinutes).toBe(60);
    const updated = data.layout as Layout;
    expect(updated.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date((before.layout as Layout).updatedAt).getTime(),
    );
    expect(rects(updated).clock).toEqual({ x: 24, y: 20, w: 224, h: 104 });
    expect(updated.modules.find((module) => module.id === 'clock')?.enabled).toBe(false);

    const readBack = await getDisplay();
    expect(readBack.refreshMinutes).toBe(60);
    expect(rects(readBack.layout as Layout).clock).toEqual({ x: 24, y: 20, w: 224, h: 104 });
  });

  it('只改 refreshMinutes 时布局不变', async () => {
    const before = await getDisplay();
    const response = await request(app).put('/api/display').send({ refreshMinutes: 120 });
    expect(response.status).toBe(200);
    expect(response.body.data.refreshMinutes).toBe(120);
    expect((response.body.data.layout as Layout).updatedAt).toBe(
      (before.layout as Layout).updatedAt,
    );
  });

  it('拒绝越界、非 4 倍数、缺模块、重复模块与额外字段', async () => {
    const before = await getDisplay();
    const base = cloneLayout(before.layout as Layout);

    const outOfBounds = cloneLayout(base);
    outOfBounds.modules = outOfBounds.modules.map((module) =>
      module.id === 'clock' ? { ...module, x: 600 } : module,
    );
    const boundsResponse = await request(app).put('/api/display').send({ layout: outOfBounds });

    const notGrid = cloneLayout(base);
    notGrid.modules = notGrid.modules.map((module) =>
      module.id === 'clock' ? { ...module, x: 17 } : module,
    );
    const gridResponse = await request(app).put('/api/display').send({ layout: notGrid });

    const missing = cloneLayout(base);
    missing.modules = missing.modules.slice(0, 5);
    const missingResponse = await request(app).put('/api/display').send({ layout: missing });

    const duplicated = cloneLayout(base);
    duplicated.modules = duplicated.modules.map((module, index) =>
      index === 1 ? { ...module, id: 'clock' } : module,
    );
    const duplicateResponse = await request(app).put('/api/display').send({ layout: duplicated });

    const extra = cloneLayout(base);
    extra.modules = extra.modules.map((module) =>
      module.id === 'clock' ? ({ ...module, extra: true } as unknown as LayoutModule) : module,
    );
    const extraResponse = await request(app).put('/api/display').send({ layout: extra });

    const wrongSize = cloneLayout(base);
    wrongSize.width = 1024 as unknown as number;
    const sizeResponse = await request(app).put('/api/display').send({ layout: wrongSize });

    for (const response of [
      boundsResponse,
      gridResponse,
      missingResponse,
      duplicateResponse,
      extraResponse,
      sizeResponse,
    ]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(response.body.error.details)).toBe(true);
    }
  });

  it('refreshMinutes 边界为 5..720', async () => {
    const tooSmall = await request(app).put('/api/display').send({ refreshMinutes: 4 });
    expect(tooSmall.status).toBe(400);
    expect(tooSmall.body.error.code).toBe('VALIDATION_FAILED');

    const tooLarge = await request(app).put('/api/display').send({ refreshMinutes: 721 });
    expect(tooLarge.status).toBe(400);

    const lower = await request(app).put('/api/display').send({ refreshMinutes: 5 });
    expect(lower.status).toBe(200);
    expect(lower.body.data.refreshMinutes).toBe(5);

    const upper = await request(app).put('/api/display').send({ refreshMinutes: 720 });
    expect(upper.status).toBe(200);
    expect(upper.body.data.refreshMinutes).toBe(720);
  });

  it('非整数刷新间隔返回 400', async () => {
    const response = await request(app).put('/api/display').send({ refreshMinutes: 30.5 });
    expect(response.status).toBe(400);
  });
});

describe('控制台屏幕预览', () => {
  it('免鉴权返回与设备屏幕一致的载荷', async () => {
    const response = await request(app).get('/api/display/screen');
    expect(response.status).toBe(200);

    const payload = response.body.data;
    expect(payload.timezone).toBe(TZ);
    expect(payload.screen).toMatchObject({ width: 800, height: 480, refreshMinutes: 30 });
    expect(payload.screen.layout.modules).toHaveLength(6);
    expect(payload.now.date).toBe(todayDateKey(TZ));
    expect(payload.now.weekday).toMatch(/^周[一二三四五六日]$/);
    expect(payload.now.time).toMatch(/^\d{2}:\d{2}$/);
    expect(payload.now.dateLabel).toMatch(/^\d{1,2}月\d{1,2}日$/);
    expect(payload.month.firstWeekday).toBeGreaterThanOrEqual(0);
    expect(payload.month.firstWeekday).toBeLessThanOrEqual(6);
    expect(payload.month.daysInMonth).toBeGreaterThanOrEqual(28);
    expect(Array.isArray(payload.month.marks)).toBe(true);
    expect(payload.events).toEqual([]);
    expect(payload.courses).toEqual([]);
    expect(payload.todos).toEqual([]);
    // 没有天气缓存时设备端拿到 null，而不是 500 或假数据
    expect(payload.weather).toBeNull();
  });
});
