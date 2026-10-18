import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';

const TZ = 'Asia/Shanghai';
const SHANGHAI_MONDAY_9AM = '2025-06-02T01:00:00.000Z'; // 2025-06-02 09:00 +08
const SHANGHAI_MONDAY_10AM = '2025-06-02T02:00:00.000Z';

let app: Express;

async function createCategory(name = '工作', color = '#3b6fd4'): Promise<number> {
  const response = await request(app).post('/api/categories').send({ name, color });
  expect(response.status).toBe(201);
  return response.body.data.id as number;
}

async function createEvent(body: Record<string, unknown>): Promise<number> {
  const response = await request(app)
    .post('/api/events')
    .send({
      title: '默认标题',
      startAt: SHANGHAI_MONDAY_9AM,
      endAt: SHANGHAI_MONDAY_10AM,
      timezone: TZ,
      ...body,
    });
  expect(response.status).toBe(201);
  return response.body.data.id as number;
}

async function listOccurrences(params: Record<string, string | number | boolean>): Promise<
  { startAt: string; eventId: number; occurrenceKey: string; isModified: boolean; title: string }[]
> {
  const response = await request(app).get('/api/occurrences').query(params);
  expect(response.status).toBe(200);
  return response.body.data;
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

describe('健康检查', () => {
  it('返回运行状态与结构版本', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(response.body.data.eventCount).toBe(0);
  });
});

describe('分类接口', () => {
  it('可以创建、列出、更新与删除分类', async () => {
    const id = await createCategory('工作', '#3b6fd4');

    const list = await request(app).get('/api/categories');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id, name: '工作', color: '#3b6fd4' });

    const updated = await request(app)
      .patch(`/api/categories/${id}`)
      .send({ name: '工作事项', color: '#2f9e6e' });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ name: '工作事项', color: '#2f9e6e' });

    const removed = await request(app).delete(`/api/categories/${id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.data).toMatchObject({ id, detachedEventCount: 0 });

    expect((await request(app).get('/api/categories')).body.data).toHaveLength(0);
  });

  it('同名分类返回 409 而不是写入重复数据', async () => {
    await createCategory('会议', '#5b6b7f');
    const duplicate = await request(app).post('/api/categories').send({ name: '会议', color: '#111111' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('CONFLICT');
  });

  it('非法颜色返回 422 并给出字段级错误', async () => {
    const response = await request(app).post('/api/categories').send({ name: '测试', color: 'blue' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details[0].path).toBe('color');
  });

  it('删除分类后关联日程变为未分类而不是被删除', async () => {
    const categoryId = await createCategory();
    await createEvent({ title: '带分类的日程', categoryId });

    const removed = await request(app).delete(`/api/categories/${categoryId}`);
    expect(removed.body.data.detachedEventCount).toBe(1);

    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(occurrences).toHaveLength(1);
  });
});

describe('日程增删改查', () => {
  it('创建后可在区间内查询到实例', async () => {
    const id = await createEvent({ title: '项目评审', location: '三号会议室' });
    expect(id).toBeGreaterThan(0);

    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]).toMatchObject({ title: '项目评审', eventId: id });
  });

  it('结束时间早于开始时间返回 422', async () => {
    const response = await request(app).post('/api/events').send({
      title: '错误时间',
      startAt: '2025-06-02T10:00:00.000Z',
      endAt: '2025-06-02T09:00:00.000Z',
      timezone: TZ,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.message).toContain('结束时间');
  });

  it('标题为空返回 422', async () => {
    const response = await request(app).post('/api/events').send({
      title: '   ',
      startAt: SHANGHAI_MONDAY_9AM,
      endAt: SHANGHAI_MONDAY_10AM,
    });
    expect(response.status).toBe(422);
  });

  it('更新日程会同步生效到区间查询', async () => {
    const id = await createEvent({ title: '原标题' });
    const updated = await request(app)
      .patch(`/api/events/${id}`)
      .send({ title: '新标题', priority: 'high' });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ title: '新标题', priority: 'high' });

    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(occurrences[0]?.title).toBe('新标题');
  });

  it('删除日程返回 204 并从查询结果移除', async () => {
    const id = await createEvent({ title: '待删除' });
    const removed = await request(app).delete(`/api/events/${id}`);
    expect(removed.status).toBe(204);

    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(occurrences).toHaveLength(0);
  });

  it('不存在的日程返回 404', async () => {
    expect((await request(app).get('/api/events/9999')).status).toBe(404);
    expect((await request(app).patch('/api/events/9999').send({ title: 'x' })).status).toBe(404);
    expect((await request(app).delete('/api/events/9999')).status).toBe(404);
  });

  it('引用不存在的分类返回 422', async () => {
    const response = await request(app).post('/api/events').send({
      title: '错误分类',
      startAt: SHANGHAI_MONDAY_9AM,
      endAt: SHANGHAI_MONDAY_10AM,
      categoryId: 12345,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.message).toContain('分类');
  });
});

describe('重复日程与实例操作', () => {
  it('每周重复在区间内展开出多个实例', async () => {
    await createEvent({ title: '周会', rrule: { freq: 'WEEKLY', interval: 1 } });
    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(occurrences.map((item) => item.startAt.slice(0, 10))).toEqual([
      '2025-06-02',
      '2025-06-09',
      '2025-06-16',
      '2025-06-23',
      '2025-06-30',
    ]);
  });

  it('「仅此一次」改期只影响当前实例', async () => {
    const id = await createEvent({ title: '周会', rrule: { freq: 'WEEKLY', interval: 1 } });
    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    const target = occurrences[2];
    expect(target).toBeDefined();

    const moved = await request(app)
      .post(`/api/events/${id}/move`)
      .send({
        occurrenceKey: target?.occurrenceKey,
        scope: 'single',
        startAt: '2025-06-17T01:00:00.000Z',
        endAt: '2025-06-17T02:00:00.000Z',
      });
    expect(moved.status).toBe(200);
    expect(moved.body.data.scope).toBe('single');

    const after = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(after.map((item) => item.startAt.slice(0, 10))).toEqual([
      '2025-06-02',
      '2025-06-09',
      '2025-06-17',
      '2025-06-23',
      '2025-06-30',
    ]);
    expect(after.find((item) => item.startAt.startsWith('2025-06-17'))?.isModified).toBe(true);
  });

  it('「整个序列」改期会平移所有实例', async () => {
    const id = await createEvent({ title: '周会', rrule: { freq: 'WEEKLY', interval: 1 } });
    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    const target = occurrences[2];
    expect(target).toBeDefined();

    const moved = await request(app)
      .post(`/api/events/${id}/move`)
      .send({
        occurrenceKey: target?.occurrenceKey,
        scope: 'all',
        startAt: '2025-06-17T01:00:00.000Z',
        endAt: '2025-06-17T02:00:00.000Z',
      });
    expect(moved.body.data.scope).toBe('all');

    const after = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(after.map((item) => item.startAt.slice(0, 10))).toEqual([
      '2025-06-03',
      '2025-06-10',
      '2025-06-17',
      '2025-06-24',
    ]);
  });

  it('「此后所有」会把序列一分为二', async () => {
    const id = await createEvent({ title: '周会', rrule: { freq: 'WEEKLY', interval: 1 } });
    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    const target = occurrences[2];
    expect(target).toBeDefined();

    const moved = await request(app)
      .post(`/api/events/${id}/move`)
      .send({
        occurrenceKey: target?.occurrenceKey,
        scope: 'future',
        startAt: '2025-06-17T01:00:00.000Z',
        endAt: '2025-06-17T02:00:00.000Z',
      });
    expect(moved.status).toBe(200);
    expect(moved.body.data.scope).toBe('future');
    expect(moved.body.data.createdEventId).toBeGreaterThan(0);

    const after = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-22T00:00:00.000Z',
    });
    expect(after.map((item) => item.startAt.slice(0, 10))).toEqual([
      '2025-06-02',
      '2025-06-09',
      '2025-06-17',
      '2025-06-24',
      '2025-07-01',
      '2025-07-08',
      '2025-07-15',
    ]);
    // 前后两段来自不同的主记录
    const eventIds = new Set(after.map((item) => item.eventId));
    expect(eventIds.size).toBe(2);

    // 原序列被截断：主记录的重复规则改为按日期截止
    const master = await request(app).get(`/api/events/${id}`);
    expect(master.body.data.rrule.until).toBe('2025-06-15');
  });

  it('取消单次实例后其余实例保留', async () => {
    const id = await createEvent({ title: '周会', rrule: { freq: 'WEEKLY', interval: 1 } });
    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });

    const cancelled = await request(app)
      .post(`/api/events/${id}/cancel-occurrence`)
      .send({ occurrenceKey: occurrences[1]?.occurrenceKey, scope: 'single' });
    expect(cancelled.status).toBe(200);

    const after = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(after.map((item) => item.startAt.slice(0, 10))).toEqual([
      '2025-06-02',
      '2025-06-16',
      '2025-06-23',
      '2025-06-30',
    ]);
  });

  it('取消「此后所有」会截断序列', async () => {
    const id = await createEvent({ title: '周会', rrule: { freq: 'WEEKLY', interval: 1 } });
    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });

    await request(app)
      .post(`/api/events/${id}/cancel-occurrence`)
      .send({ occurrenceKey: occurrences[2]?.occurrenceKey, scope: 'future' });

    const after = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(after.map((item) => item.startAt.slice(0, 10))).toEqual(['2025-06-02', '2025-06-09']);
  });

  it('实例内容覆盖与恢复', async () => {
    const id = await createEvent({ title: '周会', rrule: { freq: 'WEEKLY', interval: 1 } });
    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    const key = occurrences[1]?.occurrenceKey ?? '';

    const overridden = await request(app)
      .put(`/api/events/${id}/override`)
      .send({ occurrenceKey: key, title: '特别版周会', location: '线上' });
    expect(overridden.status).toBe(200);

    const after = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    const target = after.find((item) => item.occurrenceKey === key);
    expect(target?.title).toBe('特别版周会');
    expect(target?.isModified).toBe(true);

    const reset = await request(app).delete(
      `/api/events/${id}/override/${encodeURIComponent(key)}`,
    );
    expect(reset.status).toBe(200);

    const restored = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(restored.find((item) => item.occurrenceKey === key)?.title).toBe('周会');
  });

  it('从重复改为不重复会清理历史实例覆盖', async () => {
    const id = await createEvent({ title: '周会', rrule: { freq: 'WEEKLY', interval: 1 } });
    const occurrences = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    const key = occurrences[1]?.occurrenceKey ?? '';

    await request(app).put(`/api/events/${id}/override`).send({ occurrenceKey: key, title: '临时改名' });
    await request(app).patch(`/api/events/${id}`).send({ rrule: null });

    const overrides = await request(app).get(`/api/events/${id}/overrides`);
    expect(overrides.body.data).toHaveLength(0);

    const after = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(after).toHaveLength(1);
  });
});

describe('查询、筛选与统计', () => {
  it('关键词可匹配标题、地点、备注与标签', async () => {
    await createEvent({ title: '项目评审', location: '三号会议室' });
    await createEvent({
      title: '健身',
      startAt: '2025-06-03T11:00:00.000Z',
      endAt: '2025-06-03T12:00:00.000Z',
      tags: ['运动', '健康'],
    });

    const byTitle = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
      q: '评审',
    });
    expect(byTitle).toHaveLength(1);

    const byTag = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
      q: '健康',
    });
    expect(byTag).toHaveLength(1);

    const byLocation = await listOccurrences({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
      q: '会议室',
    });
    expect(byLocation).toHaveLength(1);
  });

  it('可以按分类与优先级筛选', async () => {
    const workId = await createCategory('工作', '#3b6fd4');
    const healthId = await createCategory('健康', '#d1554a');
    await createEvent({ title: '评审', categoryId: workId, priority: 'high' });
    await createEvent({
      title: '跑步',
      categoryId: healthId,
      startAt: '2025-06-03T11:00:00.000Z',
      endAt: '2025-06-03T12:00:00.000Z',
    });

    const range = { from: '2025-06-01T00:00:00.000Z', to: '2025-07-01T00:00:00.000Z' };

    expect(await listOccurrences({ ...range, categoryId: workId })).toHaveLength(1);
    expect(await listOccurrences({ ...range, categoryId: `${workId},${healthId}` })).toHaveLength(2);
    expect(await listOccurrences({ ...range, priority: 'high' })).toHaveLength(1);
  });

  it('默认不返回已取消的实例，可用 includeCancelled 打开', async () => {
    await createEvent({ title: '已取消', status: 'cancelled' });
    const range = { from: '2025-06-01T00:00:00.000Z', to: '2025-07-01T00:00:00.000Z' };
    expect(await listOccurrences(range)).toHaveLength(0);
    expect(await listOccurrences({ ...range, includeCancelled: true })).toHaveLength(1);
  });

  it('区间跨度超过上限时返回 400', async () => {
    const response = await request(app).get('/api/occurrences').query({
      from: '2024-01-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('400');
  });

  it('区间终点早于起点时返回 400', async () => {
    const response = await request(app).get('/api/occurrences').query({
      from: '2025-06-10T00:00:00.000Z',
      to: '2025-06-01T00:00:00.000Z',
    });
    expect(response.status).toBe(400);
  });

  it('统计接口汇总数量、时长与分类分布', async () => {
    const workId = await createCategory('工作', '#3b6fd4');
    await createEvent({ title: '评审', categoryId: workId });
    await createEvent({
      title: '评审二',
      startAt: '2025-06-02T03:00:00.000Z',
      endAt: '2025-06-02T05:00:00.000Z',
      categoryId: workId,
      priority: 'urgent',
    });

    const response = await request(app).get('/api/stats/summary').query({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-07-01T00:00:00.000Z',
    });
    expect(response.status).toBe(200);
    expect(response.body.data.totalOccurrences).toBe(2);
    expect(response.body.data.totalMinutes).toBe(180);
    expect(response.body.data.byCategory[0]).toMatchObject({ categoryId: workId, count: 2 });
    expect(response.body.data.byPriority[0]).toMatchObject({ priority: 'urgent', count: 1 });
    expect(response.body.data.byDay).toHaveLength(1);
  });
});

describe('提醒接口', () => {
  it('只在提醒触发窗口内返回待提醒日程', async () => {
    await createEvent({ title: '评审', remindMinutesBefore: 30 });

    const inWindow = await request(app).get('/api/reminders/due').query({
      from: '2025-06-02T00:25:00.000Z',
      to: '2025-06-02T00:35:00.000Z',
    });
    expect(inWindow.status).toBe(200);
    expect(inWindow.body.data).toHaveLength(1);
    expect(inWindow.body.data[0]).toMatchObject({
      title: '评审',
      minutesBefore: 30,
      fireAt: '2025-06-02T00:30:00.000Z',
    });

    const outOfWindow = await request(app).get('/api/reminders/due').query({
      from: '2025-06-01T00:00:00.000Z',
      to: '2025-06-01T01:00:00.000Z',
    });
    expect(outOfWindow.body.data).toHaveLength(0);
  });

  it('未设置提醒的日程不会出现在提醒列表', async () => {
    await createEvent({ title: '无提醒' });
    const response = await request(app).get('/api/reminders/due').query({
      from: '2025-06-02T00:00:00.000Z',
      to: '2025-06-02T01:00:00.000Z',
    });
    expect(response.body.data).toHaveLength(0);
  });
});

describe('日程主记录列表', () => {
  it('支持分页与排序', async () => {
    await createEvent({ title: 'B 日程' });
    await createEvent({
      title: 'A 日程',
      startAt: '2025-06-03T01:00:00.000Z',
      endAt: '2025-06-03T02:00:00.000Z',
    });

    const sorted = await request(app).get('/api/events').query({ sort: 'title', limit: 10 });
    expect(sorted.body.data.map((item: { title: string }) => item.title)).toEqual(['A 日程', 'B 日程']);
    expect(sorted.body.meta.total).toBe(2);

    const paged = await request(app).get('/api/events').query({ limit: 1, offset: 1, sort: 'title' });
    expect(paged.body.data).toHaveLength(1);
    expect(paged.body.meta).toMatchObject({ total: 2, limit: 1, offset: 1 });
  });
});

describe('错误处理', () => {
  it('未知接口返回 404 JSON', async () => {
    const response = await request(app).get('/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('非法 JSON 请求体返回 400', async () => {
    const response = await request(app)
      .post('/api/events')
      .set('Content-Type', 'application/json')
      .send('{"title": ');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('请求会带上 requestId 便于排查', async () => {
    const response = await request(app).get('/api/health').set('X-Request-Id', 'trace-123');
    expect(response.headers['x-request-id']).toBe('trace-123');
  });
});
