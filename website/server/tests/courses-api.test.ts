/**
 * 课程同步的接口级集成测试。
 *
 * 用 rawHtml 注入课表，完全走本地逻辑（不访问真实校方站点），
 * 用来锁住「配置 → 解析 → 生成日程 → 幂等再同步 → 差量删除」这条主线。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { closeDatabase, getDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { setupTestAdmin } from './helpers/auth.js';

const TERM_ID = '102';
const TERM_NAME = '2026-2027学年第一学程';
const TERM_START = '2026-08-31'; // 周一
const PASSWORD = 'Wjy090317';

let app: Express;
let agent: Awaited<ReturnType<typeof setupTestAdmin>>;

interface FixtureSlot {
  weekday: number;
  period: number;
  name: string;
  teacher?: string;
  room?: string;
}

const WEEKDAY_LABELS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
/** 表头列顺序与真实站点一致：第 1 个数据列是星期日，然后是星期一…星期六 */
const COLUMN_ORDER = [7, 1, 2, 3, 4, 5, 6];

/** 造一份与真实站点结构一致的课表 HTML。 */
function makeTimetableHtml(slots: FixtureSlot[], options: { withDates?: boolean } = {}): string {
  const withDates = options.withDates ?? true;
  const header = COLUMN_ORDER.map((weekday) => {
    const label = WEEKDAY_LABELS[weekday];
    return `<td>${withDates ? `${label}(2026-10-12)` : label}</td>`;
  }).join('');

  const periodNumbers = [...new Set(slots.map((slot) => slot.period))].sort((a, b) => a - b);
  const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const rows = periodNumbers
    .map((period) => {
      const cells = COLUMN_ORDER.map((weekday) => {
        const hit = slots.find((slot) => slot.weekday === weekday && slot.period === period);
        if (!hit) return '<td class="spec_td"></td>';
        const divs = [hit.name, hit.teacher ?? '', hit.room ?? '']
          .filter((text) => text.length > 0)
          .map((text) => `<div>${text}</div>`)
          .join('');
        return `<td class="spec_td"><span>${divs}</span></td>`;
      }).join('');
      return `<tr><td>第${CN[period] ?? period}节</td>${cells}</tr>`;
    })
    .join('');

  return `<select id="xuecheng"><option value="101">旧学程</option><option value="${TERM_ID}" selected>${TERM_NAME}</option></select><table><tr><td></td>${header}</tr>${rows}</table>`;
}

async function setSettings(patch: Record<string, unknown>): Promise<void> {
  const response = await agent.patch('/api/courses/settings').send(patch);
  expect(response.status).toBe(200);
}

async function importWith(html: string): Promise<Record<string, unknown>> {
  const response = await agent.post('/api/courses/import').send({ rawHtml: html });
  expect(response.status).toBe(200);
  return response.body.data as Record<string, unknown>;
}

beforeEach(async () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  runMigrations(db);
  setDatabaseForTesting(db);
  app = createApp();
  agent = await setupTestAdmin(app);
});

afterAll(() => {
  closeDatabase();
  setDatabaseForTesting(null);
});

describe('课程同步设置', () => {
  it('默认返回一套可用的节次时间与关闭的自动同步', async () => {
    const response = await agent.get('/api/courses/settings');
    expect(response.status).toBe(200);
    expect(response.body.data.periods.length).toBeGreaterThanOrEqual(8);
    expect(response.body.data.fridaySeparate).toBe(false);
    expect(response.body.data.autoSync).toBe(false);
    expect(response.body.data.baseUrl).toBe('http://ws8.yucai.sh.cn');
  });

  it('可以修改节次时间、周五单独时间、学期区间与自动同步', async () => {
    await setSettings({
      periods: [{ index: 1, start: '07:30', end: '08:10' }],
      fridaySeparate: true,
      fridayPeriods: [{ index: 1, start: '09:30', end: '10:10' }],
      termStartDate: TERM_START,
      totalWeeks: 18,
      autoSync: true,
      syncIntervalHours: 12,
    });
    const response = await agent.get('/api/courses/settings');
    expect(response.body.data).toMatchObject({
      fridaySeparate: true,
      termStartDate: TERM_START,
      totalWeeks: 18,
      autoSync: true,
      syncIntervalHours: 12,
    });
    expect(response.body.data.periods).toEqual([{ index: 1, start: '07:30', end: '08:10' }]);
    expect(response.body.data.fridayPeriods).toEqual([{ index: 1, start: '09:30', end: '10:10' }]);
  });

  it('拒绝结束时间早于开始时间的节次', async () => {
    const response = await agent
      .patch('/api/courses/settings')
      .send({ periods: [{ index: 1, start: '10:00', end: '09:00' }] });
    expect(response.status).toBe(422);
  });
});

describe('凭据保存', () => {
  it('保存后可以读到账号，但永远不回传密码；库里也不存明文', async () => {
    const saved = await agent
      .put('/api/courses/credentials')
      .send({ username: '20240116', password: PASSWORD, remember: true });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ username: '20240116', remember: true });
    expect(JSON.stringify(saved.body)).not.toContain(PASSWORD);

    const status = await agent.get('/api/courses/status');
    expect(status.body.data.credentials).toMatchObject({
      username: '20240116',
      hasPassword: true,
      remember: true,
    });
    expect(JSON.stringify(status.body)).not.toContain(PASSWORD);

    // 直接查库：密文里不能出现明文
    const db = getDatabase();
    const row = db
      .prepare('SELECT username, secret FROM sync_credentials WHERE user_id = (SELECT id FROM users ORDER BY id LIMIT 1)')
      .get() as { username: string; secret: string };
    expect(row.username).toBe('20240116');
    expect(row.secret).not.toContain(PASSWORD);
    expect(row.secret.startsWith('v1:')).toBe(true);
  });

  it('可以删除已保存的凭据', async () => {
    await agent.put('/api/courses/credentials').send({ username: 'u', password: 'p' });
    const removed = await agent.delete('/api/courses/credentials');
    expect(removed.body.data.removed).toBe(true);
    const status = await agent.get('/api/courses/status');
    expect(status.body.data.credentials.hasPassword).toBe(false);
  });

  it('未保存凭据又要求联网导入时返回 422 且给出指引', async () => {
    const response = await agent.post('/api/courses/import').send({});
    expect(response.status).toBe(422);
    expect(response.body.error.message).toContain('尚未保存');
  });
});

describe('课表预览', () => {
  it('把节次换算成当天具体时间，并按学期第一周定位日期', async () => {
    await setSettings({ termStartDate: TERM_START, totalWeeks: 20 });
    const html = makeTimetableHtml([
      { weekday: 1, period: 1, name: '高三语文1-1', teacher: '朱英杰', room: '301' },
      { weekday: 5, period: 2, name: '高三数学1-1', teacher: '蔡晙晔', room: '301' },
    ]);

    const response = await agent.post('/api/courses/preview').send({ rawHtml: html });
    expect(response.status).toBe(200);
    const preview = response.body.data;
    expect(preview.termId).toBe(TERM_ID);
    expect(preview.termName).toBe(TERM_NAME);
    expect(preview.termStartDate).toBe(TERM_START);
    expect(preview.termStartInferred).toBe(false);
    expect(preview.slots).toHaveLength(2);

    const monday = preview.slots.find((slot: { weekday: number }) => slot.weekday === 1);
    const mondayStart = new Date(monday.firstStartAt);
    expect(mondayStart.getFullYear()).toBe(2026);
    expect(mondayStart.getMonth()).toBe(7); // 8 月
    expect(mondayStart.getDate()).toBe(31);
    expect(mondayStart.getHours()).toBe(8);
    expect(mondayStart.getMinutes()).toBe(0);
    expect(new Date(monday.firstEndAt).getHours()).toBe(8);
    expect(new Date(monday.firstEndAt).getMinutes()).toBe(40);

    const friday = preview.slots.find((slot: { weekday: number }) => slot.weekday === 5);
    expect(new Date(friday.firstStartAt).getDate()).toBe(4); // 9/4 周五
  });

  it('未配置学期起始日时按当周推断并给出提醒', async () => {
    const html = makeTimetableHtml([{ weekday: 1, period: 1, name: '语文' }]);
    const response = await agent.post('/api/courses/preview').send({ rawHtml: html });
    expect(response.body.data.termStartInferred).toBe(true);
    expect(response.body.data.warnings.join(' ')).toContain('第一周');
  });

  it('勾选周五单独时间后，周五使用独立时间表而其他天不变', async () => {
    await setSettings({
      termStartDate: TERM_START,
      periods: [{ index: 1, start: '08:00', end: '08:40' }],
      fridaySeparate: true,
      fridayPeriods: [{ index: 1, start: '09:30', end: '10:10' }],
    });
    const html = makeTimetableHtml([
      { weekday: 1, period: 1, name: '周一语文' },
      { weekday: 5, period: 1, name: '周五数学' },
    ]);

    const preview = (await agent.post('/api/courses/preview').send({ rawHtml: html })).body.data;
    const monday = preview.slots.find((slot: { weekday: number }) => slot.weekday === 1);
    const friday = preview.slots.find((slot: { weekday: number }) => slot.weekday === 5);

    expect(new Date(monday.firstStartAt).getHours()).toBe(8);
    expect(new Date(friday.firstStartAt).getHours()).toBe(9);
    expect(new Date(friday.firstStartAt).getMinutes()).toBe(30);
    expect(new Date(friday.firstEndAt).getHours()).toBe(10);
    expect(preview.warnings.join(' ')).toContain('周五');
  });

  it('节次时间没配全时用顺延估算并明确提示', async () => {
    await setSettings({ termStartDate: TERM_START, periods: [{ index: 1, start: '08:00', end: '08:40' }] });
    const html = makeTimetableHtml([
      { weekday: 1, period: 1, name: '第一节' },
      { weekday: 1, period: 3, name: '第三节' },
    ]);
    const preview = (await agent.post('/api/courses/preview').send({ rawHtml: html })).body.data;
    expect(preview.slots.find((slot: { period: number }) => slot.period === 3).timeFallback).toBe(true);
    expect(preview.warnings.join(' ')).toContain('顺延');
  });
});

describe('导入与幂等同步', () => {
  const html = makeTimetableHtml([
    { weekday: 1, period: 1, name: '高三语文1-1', teacher: '朱英杰', room: '301' },
    { weekday: 3, period: 1, name: '高三英语1-1', teacher: '童阳', room: '301' },
    { weekday: 5, period: 1, name: '高三数学1-1', teacher: '蔡晙晔', room: '301' },
  ]);

  it('首次导入创建日程，并自动建好「课程」分类', async () => {
    await setSettings({ termStartDate: TERM_START, totalWeeks: 20 });
    const result = await importWith(html);
    expect(result).toMatchObject({ created: 3, updated: 0, removed: 0 });

    const categories = await agent.get('/api/categories');
    const course = categories.body.data.find((item: { name: string }) => item.name === '课程');
    expect(course).toBeDefined();

    const events = await agent.get('/api/events').query({ limit: 50 });
    expect(events.body.meta.total).toBe(3);
    const first = events.body.data.find((item: { title: string }) => item.title === '高三语文1-1');
    expect(first.location).toBe('301');
    expect(first.description).toContain('朱英杰');
    expect(first.rrule).toMatchObject({ freq: 'WEEKLY', interval: 1 });
    expect(first.rrule.until).toBe('2027-01-17'); // 8/31 起 20 周
  });

  it('重复导入只更新、不产生重复数据', async () => {
    await setSettings({ termStartDate: TERM_START });
    await importWith(html);
    const second = await importWith(html);
    expect(second).toMatchObject({ created: 0, updated: 3, removed: 0 });

    const events = await agent.get('/api/events').query({ limit: 50 });
    expect(events.body.meta.total).toBe(3);
  });

  it('课表里消失的条目会在下次同步时被删除', async () => {
    await setSettings({ termStartDate: TERM_START });
    await importWith(html);

    const reduced = makeTimetableHtml([
      { weekday: 1, period: 1, name: '高三语文1-1', teacher: '朱英杰', room: '301' },
    ]);
    const result = await importWith(reduced);
    expect(result).toMatchObject({ created: 0, updated: 1, removed: 2 });

    const events = await agent.get('/api/events').query({ limit: 50 });
    expect(events.body.meta.total).toBe(1);
  });

  it('课程改名后同步会把日程标题一起更新', async () => {
    await setSettings({ termStartDate: TERM_START });
    await importWith(makeTimetableHtml([{ weekday: 1, period: 1, name: '旧课名' }]));
    await importWith(makeTimetableHtml([{ weekday: 1, period: 1, name: '新课名' }]));

    const events = await agent.get('/api/events').query({ limit: 50 });
    expect(events.body.data.map((item: { title: string }) => item.title)).toEqual(['新课名']);
  });

  it('导入的课程是每周重复，并落在学期区间内', async () => {
    await setSettings({ termStartDate: TERM_START, totalWeeks: 4 });
    await importWith(makeTimetableHtml([{ weekday: 1, period: 1, name: '语文' }]));

    const occurrences = await agent.get('/api/occurrences').query({
      from: new Date(2026, 7, 30).toISOString(),
      to: new Date(2026, 9, 1).toISOString(),
    });
    expect(occurrences.status).toBe(200);
    expect(occurrences.body.data.map((item: { startAt: string }) => item.startAt.slice(0, 10))).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
    ]);
  });

  it('手动删除某条课程日程后再次同步会重新建立，不会留下悬空映射', async () => {
    await setSettings({ termStartDate: TERM_START });
    await importWith(html);

    const events = await agent.get('/api/events').query({ limit: 50 });
    const target = events.body.data.find((item: { title: string }) => item.title === '高三英语1-1');
    await agent.delete(`/api/events/${target.id}`);

    const result = await importWith(html);
    expect(result).toMatchObject({ created: 1, updated: 2, removed: 0 });

    const after = await agent.get('/api/events').query({ limit: 50 });
    expect(after.body.meta.total).toBe(3);
  });

  it('同步完成后状态接口给出最近一次结果', async () => {
    await setSettings({ termStartDate: TERM_START });
    await importWith(html);

    const status = await agent.get('/api/courses/status');
    expect(status.body.data.lastRun).toMatchObject({ status: 'success', created: 3, total: 3 });
    expect(status.body.data.linkedCount).toBe(3);
    expect(status.body.data.settings.termStartDate).toBe(TERM_START);
  });

  it('同步失败时记录失败原因，且不破坏已有数据', async () => {
    await setSettings({ termStartDate: TERM_START });
    await importWith(html);

    const broken = await agent.post('/api/courses/import').send({ rawHtml: '<table><tr><td>空</td></tr></table>' });
    expect(broken.status).toBe(400);

    const status = await agent.get('/api/courses/status');
    expect(status.body.data.lastRun.status).toBe('failed');

    const events = await agent.get('/api/events').query({ limit: 50 });
    expect(events.body.meta.total).toBe(3);
  });
});
