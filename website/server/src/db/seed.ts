/**
 * 演示数据。
 *
 * 仅在指定用户的事件表为空时写入，因此可以安全地在初始化/启动时调用。
 * 所有时间都相对“今天”生成，保证第一次打开页面就能看到内容饱满的日历。
 */

import { countEvents } from '../modules/events/repository.js';
import { createCategory, listCategories } from '../modules/categories.js';
import { createEvent } from '../modules/events/service.js';
import { readDisplayTimezone } from '../modules/display/settings.js';
import { toDateKey, wallTimeToInstant, dateKeyToUtcDate } from '../domain/time.js';
import type { SqliteDatabase } from './client.js';

export interface SeedResult {
  seeded: boolean;
  categoryCount: number;
  eventCount: number;
}

interface SeedCategory {
  name: string;
  color: string;
  icon: string;
}

const SEED_CATEGORIES: readonly SeedCategory[] = [
  { name: '工作', color: '#3b6fd4', icon: 'briefcase' },
  { name: '会议', color: '#5b6b7f', icon: 'users-three' },
  { name: '个人', color: '#2f9e6e', icon: 'user' },
  { name: '学习', color: '#c08a20', icon: 'book-open' },
  { name: '健康', color: '#d1554a', icon: 'heartbeat' },
];

function pad(value: number): string {
  return `${value}`.padStart(2, '0');
}

function addDays(dateKey: string, days: number): string {
  const base = dateKeyToUtcDate(dateKey);
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
}

function instantAt(dateKey: string, hour: number, minute = 0, timeZone: string): string {
  const base = dateKeyToUtcDate(dateKey);
  return wallTimeToInstant(
    {
      year: base.getUTCFullYear(),
      month: base.getUTCMonth() + 1,
      day: base.getUTCDate(),
      hour,
      minute,
    },
    timeZone,
  ).toISOString();
}

export function seedDemoData(
  db: SqliteDatabase,
  userId: number,
  now: Date = new Date(),
): SeedResult {
  if (countEvents(db, userId) > 0) {
    return { seeded: false, categoryCount: 0, eventCount: 0 };
  }

  const timeZone = readDisplayTimezone(db, userId);
  const today = toDateKey(now, timeZone);

  const categories = new Map<string, number>();
  const existing = listCategories(db, userId);
  if (existing.length === 0) {
    for (const seed of SEED_CATEGORIES) {
      const created = createCategory(seed, userId, db);
      categories.set(seed.name, created.id);
    }
  } else {
    for (const category of existing) categories.set(category.name, category.id);
  }

  const work = categories.get('工作') ?? null;
  const meeting = categories.get('会议') ?? null;
  const personal = categories.get('个人') ?? null;
  const study = categories.get('学习') ?? null;
  const health = categories.get('健康') ?? null;

  let created = 0;
  const add = (input: Parameters<typeof createEvent>[0]): void => {
    createEvent(input, userId, db);
    created += 1;
  };

  add({
    title: '项目评审会',
    description: '确认本迭代交付范围与风险项，会后同步任务分派。',
    location: '三号会议室',
    categoryId: meeting,
    priority: 'high',
    startAt: instantAt(today, 14, 0, timeZone),
    endAt: instantAt(today, 15, 30, timeZone),
    tags: ['迭代', '评审'],
    remindMinutesBefore: 30,
  });

  add({
    title: '团队周会',
    description: '同步上周进展与本週计划。',
    location: '线上会议',
    categoryId: work,
    priority: 'normal',
    startAt: instantAt(today, 10, 0, timeZone),
    endAt: instantAt(today, 11, 0, timeZone),
    tags: ['例行'],
    remindMinutesBefore: 15,
    rrule: { freq: 'WEEKLY', interval: 1, byWeekday: [1] },
  });

  add({
    title: '产品路线图讨论',
    description: '梳理下一阶段的功能优先级。',
    location: '线上会议',
    categoryId: work,
    priority: 'high',
    startAt: instantAt(addDays(today, 1), 11, 0, timeZone),
    endAt: instantAt(addDays(today, 1), 12, 0, timeZone),
    tags: ['路线图'],
    remindMinutesBefore: 15,
  });

  add({
    title: '季度出差',
    description: '客户现场走访与需求确认。',
    location: '杭州',
    categoryId: work,
    priority: 'normal',
    allDay: true,
    startAt: addDays(today, 3),
    endAt: addDays(today, 5),
    tags: ['出差'],
  });

  add({
    title: '健身训练',
    categoryId: health,
    priority: 'normal',
    startAt: instantAt(today, 19, 0, timeZone),
    endAt: instantAt(today, 20, 0, timeZone),
    tags: ['运动'],
    remindMinutesBefore: 30,
    rrule: { freq: 'DAILY', interval: 1, count: 30 },
  });

  add({
    title: '英语精读',
    description: '每天 45 分钟，重点练听力。',
    categoryId: study,
    priority: 'low',
    startAt: instantAt(today, 21, 0, timeZone),
    endAt: instantAt(today, 21, 45, timeZone),
    tags: ['语言', '每日'],
    remindMinutesBefore: 10,
    rrule: { freq: 'DAILY', interval: 1 },
  });

  add({
    title: '月度复盘',
    description: '整理本月数据并输出结论。',
    categoryId: work,
    priority: 'high',
    startAt: instantAt(today, 17, 0, timeZone),
    endAt: instantAt(today, 18, 0, timeZone),
    tags: ['复盘'],
    remindMinutesBefore: 20,
    rrule: { freq: 'MONTHLY', interval: 1 },
  });

  add({
    title: '体检预约',
    location: '市第一医院体检中心',
    categoryId: health,
    priority: 'urgent',
    startAt: instantAt(addDays(today, 9), 9, 30, timeZone),
    endAt: instantAt(addDays(today, 9), 10, 30, timeZone),
    tags: ['预约'],
    remindMinutesBefore: 1440,
  });

  add({
    title: '朋友生日',
    location: '线上祝福',
    categoryId: personal,
    priority: 'normal',
    allDay: true,
    startAt: addDays(today, 6),
    endAt: addDays(today, 6),
    tags: ['纪念日'],
    remindMinutesBefore: 1440,
    rrule: { freq: 'YEARLY', interval: 1 },
  });

  add({
    title: '阅读与笔记',
    description: '读完本周选定章节并整理卡片。',
    categoryId: study,
    priority: 'low',
    startAt: instantAt(addDays(today, -2), 20, 30, timeZone),
    endAt: instantAt(addDays(today, -2), 21, 30, timeZone),
    tags: ['阅读'],
  });

  return { seeded: true, categoryCount: SEED_CATEGORIES.length, eventCount: created };
}
