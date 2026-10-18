import { describe, expect, it } from 'vitest';
import {
  describeRecurrence,
  expandEvent,
  normalizeRecurrenceRule,
  seriesIndexBefore,
  truncateUntilKeyFor,
  type ExpandableEvent,
} from '../src/domain/recurrence.js';
import type { EventOverride, RecurrenceRule } from '../src/domain/types.js';

const SHANGHAI = 'Asia/Shanghai';

function makeEvent(partial: Partial<ExpandableEvent> = {}): ExpandableEvent {
  return {
    id: 1,
    title: '测试日程',
    description: '',
    location: '',
    categoryId: null,
    priority: 'normal',
    status: 'confirmed',
    allDay: false,
    startAt: '2025-06-02T01:00:00.000Z', // 2025-06-02 09:00 +08
    endAt: '2025-06-02T02:00:00.000Z', // 2025-06-02 10:00 +08
    timezone: SHANGHAI,
    tags: [],
    rrule: null,
    color: null,
    remindMinutesBefore: null,
    ...partial,
  };
}

function expand(
  event: ExpandableEvent,
  fromIso: string,
  toIso: string,
  options: { limit?: number; overrides?: EventOverride[] } = {},
) {
  return expandEvent(event, options.overrides ?? [], {
    rangeStart: new Date(fromIso),
    rangeEnd: new Date(toIso),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
}

function makeOverride(partial: Partial<EventOverride> & { occurrenceKey: string }): EventOverride {
  return {
    id: 1,
    eventId: 1,
    cancelled: false,
    title: null,
    description: null,
    location: null,
    priority: null,
    startAt: null,
    endAt: null,
    allDay: null,
    categoryId: null,
    tags: null,
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    ...partial,
  };
}

describe('重复规则归一化', () => {
  it('把非法或缺失的 interval 收敛到 1', () => {
    expect(normalizeRecurrenceRule({ freq: 'DAILY', interval: 0 })?.interval).toBe(1);
    expect(normalizeRecurrenceRule({ freq: 'DAILY', interval: -5 })?.interval).toBe(1);
    expect(normalizeRecurrenceRule({ freq: 'DAILY', interval: 999 })?.interval).toBe(365);
  });

  it('清理并排序 byWeekday，去重且剔除越界值', () => {
    const rule = normalizeRecurrenceRule({
      freq: 'WEEKLY',
      interval: 1,
      byWeekday: [5, 1, 1, 9, -1, 3],
    });
    expect(rule?.byWeekday).toEqual([1, 3, 5]);
  });

  it('选中全部 7 天时视为每天，不保留 byWeekday', () => {
    const rule = normalizeRecurrenceRule({
      freq: 'WEEKLY',
      interval: 1,
      byWeekday: [0, 1, 2, 3, 4, 5, 6],
    });
    expect(rule?.byWeekday).toBeUndefined();
  });

  it('count 优先于 until', () => {
    const rule = normalizeRecurrenceRule({
      freq: 'DAILY',
      interval: 1,
      count: 3,
      until: '2026-01-01',
    });
    expect(rule?.count).toBe(3);
    expect(rule?.until).toBeUndefined();
  });
});

describe('事件展开', () => {
  it('非重复事件只在区间内出现一次', () => {
    const event = makeEvent();
    expect(expand(event, '2025-06-01T00:00:00Z', '2025-06-10T00:00:00Z')).toHaveLength(1);
    expect(expand(event, '2025-07-01T00:00:00Z', '2025-07-10T00:00:00Z')).toHaveLength(0);
  });

  it('覆盖区间边界的事件也会被包含（与区间相交即算）', () => {
    const event = makeEvent({
      startAt: '2025-06-01T20:00:00.000Z',
      endAt: '2025-06-02T04:00:00.000Z',
    });
    // 查询区间从 06-02 00:00 开始，事件在区间开始前就开始了但尚未结束
    const result = expand(event, '2025-06-02T00:00:00Z', '2025-06-03T00:00:00Z');
    expect(result).toHaveLength(1);
  });

  it('已取消的主事件不产生任何实例', () => {
    const event = makeEvent({ status: 'cancelled' });
    expect(expand(event, '2025-06-01T00:00:00Z', '2025-06-10T00:00:00Z')).toHaveLength(0);
  });

  it('每天重复：count 限制总次数', () => {
    const event = makeEvent({ rrule: { freq: 'DAILY', interval: 1, count: 3 } });
    const result = expand(event, '2025-06-01T00:00:00Z', '2025-06-10T00:00:00Z');
    expect(result.map((item) => item.startAt)).toEqual([
      '2025-06-02T01:00:00.000Z',
      '2025-06-03T01:00:00.000Z',
      '2025-06-04T01:00:00.000Z',
    ]);
    expect(result.every((item) => item.isRecurring)).toBe(true);
  });

  it('每天重复：until 为闭区间', () => {
    const event = makeEvent({ rrule: { freq: 'DAILY', interval: 1, until: '2025-06-04' } });
    const result = expand(event, '2025-06-01T00:00:00Z', '2025-06-30T00:00:00Z');
    expect(result).toHaveLength(3);
  });

  it('每 2 天重复：按 interval 跳步', () => {
    const event = makeEvent({ rrule: { freq: 'DAILY', interval: 2 } });
    const result = expand(event, '2025-06-01T00:00:00Z', '2025-06-08T00:00:00Z');
    expect(result.map((item) => item.startAt.slice(0, 10))).toEqual(['2025-06-02', '2025-06-04', '2025-06-06']);
  });

  it('每周重复：byWeekday 在首周早于起始日的星期会被跳过', () => {
    // 起始日 2025-06-02 是周一，byWeekday=[0] 表示周日，首次应落到 06-08
    const event = makeEvent({ rrule: { freq: 'WEEKLY', interval: 1, byWeekday: [0] } });
    const result = expand(event, '2025-06-01T00:00:00Z', '2025-06-20T00:00:00Z');
    expect(result.map((item) => item.startAt.slice(0, 10))).toEqual(['2025-06-08', '2025-06-15']);
  });

  it('每周重复：多个星期按时间升序输出', () => {
    const event = makeEvent({ rrule: { freq: 'WEEKLY', interval: 1, byWeekday: [3, 1] } });
    const result = expand(event, '2025-06-01T00:00:00Z', '2025-06-16T00:00:00Z');
    expect(result.map((item) => item.startAt.slice(0, 10))).toEqual([
      '2025-06-02',
      '2025-06-04',
      '2025-06-09',
      '2025-06-11',
    ]);
  });

  it('每月重复：当月不存在该日时跳过，而不是顺延', () => {
    const event = makeEvent({
      startAt: '2025-01-31T01:00:00.000Z',
      endAt: '2025-01-31T02:00:00.000Z',
      rrule: { freq: 'MONTHLY', interval: 1 },
    });
    const result = expand(event, '2025-01-01T00:00:00Z', '2025-08-01T00:00:00Z');
    expect(result.map((item) => item.startAt.slice(0, 10))).toEqual([
      '2025-01-31',
      '2025-03-31',
      '2025-05-31',
      '2025-07-31',
    ]);
  });

  it('每年重复：2 月 29 日在非闰年跳过', () => {
    const event = makeEvent({
      startAt: '2024-02-29T01:00:00.000Z',
      endAt: '2024-02-29T02:00:00.000Z',
      rrule: { freq: 'YEARLY', interval: 1 },
    });
    const result = expand(event, '2024-01-01T00:00:00Z', '2029-01-01T00:00:00Z');
    expect(result.map((item) => item.startAt.slice(0, 10))).toEqual(['2024-02-29', '2028-02-29']);
  });

  it('跨夏令时仍保持墙上时间不变', () => {
    // 2025-03-05 09:00 EST = 14:00Z；03-09 之后进入 EDT，09:00 应为 13:00Z
    const event = makeEvent({
      startAt: '2025-03-05T14:00:00.000Z',
      endAt: '2025-03-05T15:00:00.000Z',
      timezone: 'America/New_York',
      rrule: { freq: 'WEEKLY', interval: 1 },
    });
    const result = expand(event, '2025-03-01T00:00:00Z', '2025-03-20T00:00:00Z');
    expect(result.map((item) => item.startAt)).toEqual([
      '2025-03-05T14:00:00.000Z',
      '2025-03-12T13:00:00.000Z',
      '2025-03-19T13:00:00.000Z',
    ]);
  });

  it('全天重复事件使用日期串且不经过时区换算', () => {
    const event = makeEvent({
      allDay: true,
      startAt: '2025-06-02',
      endAt: '2025-06-03',
      rrule: { freq: 'DAILY', interval: 1, count: 3 },
    });
    const result = expand(event, '2025-05-31T16:00:00Z', '2025-06-09T16:00:00Z');
    expect(result.map((item) => [item.startAt, item.endAt])).toEqual([
      ['2025-06-02', '2025-06-03'],
      ['2025-06-03', '2025-06-04'],
      ['2025-06-04', '2025-06-05'],
    ]);
    expect(result.every((item) => item.allDay)).toBe(true);
  });

  it('limit 会截断结果数量', () => {
    const event = makeEvent({ rrule: { freq: 'DAILY', interval: 1 } });
    const result = expand(event, '2025-06-01T00:00:00Z', '2025-07-01T00:00:00Z', { limit: 5 });
    expect(result).toHaveLength(5);
  });

  it('异常规则不会让服务失控（最大迭代次数兜底）', () => {
    const event = makeEvent({ rrule: { freq: 'DAILY', interval: 1 } });
    const started = Date.now();
    const result = expandEvent(event, [], {
      rangeStart: new Date('2025-06-02T00:00:00Z'),
      rangeEnd: new Date('2025-06-03T00:00:00Z'),
      maxIterations: 50,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('实例级覆盖', () => {
  it('取消单次实例后该次不再出现', () => {
    const event = makeEvent({ rrule: { freq: 'DAILY', interval: 1 } });
    const result = expand(event, '2025-06-01T00:00:00Z', '2025-06-05T00:00:00Z', {
      overrides: [makeOverride({ occurrenceKey: '2025-06-03T01:00:00.000Z', cancelled: true })],
    });
    expect(result.map((item) => item.startAt.slice(0, 10))).toEqual(['2025-06-02', '2025-06-04']);
  });

  it('修改单次实例的时间与内容后按覆盖值输出', () => {
    const event = makeEvent({ rrule: { freq: 'DAILY', interval: 1 } });
    const result = expand(event, '2025-06-01T00:00:00Z', '2025-06-05T00:00:00Z', {
      overrides: [
        makeOverride({
          occurrenceKey: '2025-06-03T01:00:00.000Z',
          title: '改过的标题',
          startAt: '2025-06-03T06:00:00.000Z',
          endAt: '2025-06-03T07:00:00.000Z',
        }),
      ],
    });
    const modified = result.find((item) => item.occurrenceKey === '2025-06-03T01:00:00.000Z');
    expect(modified?.title).toBe('改过的标题');
    expect(modified?.startAt).toBe('2025-06-03T06:00:00.000Z');
    expect(modified?.isModified).toBe(true);
  });

  it('被改期到区间外的实例不会因为原键在区间内而出现', () => {
    const event = makeEvent({ rrule: { freq: 'DAILY', interval: 1 } });
    const result = expand(event, '2025-06-01T00:00:00Z', '2025-06-05T00:00:00Z', {
      overrides: [
        makeOverride({
          occurrenceKey: '2025-06-03T01:00:00.000Z',
          startAt: '2025-09-03T01:00:00.000Z',
          endAt: '2025-09-03T02:00:00.000Z',
        }),
      ],
    });
    expect(result.map((item) => item.startAt.slice(0, 10))).toEqual(['2025-06-02', '2025-06-04']);
  });

  it('取消全天实例使用日期串作为键', () => {
    const event = makeEvent({
      allDay: true,
      startAt: '2025-06-02',
      endAt: '2025-06-02',
      rrule: { freq: 'DAILY', interval: 1 },
    });
    // 区间按事件时区对齐：2025-05-31T16:00Z ~ 2025-06-04T16:00Z 即上海时间 6/1 ~ 6/5
    const result = expand(event, '2025-05-31T16:00:00Z', '2025-06-04T16:00:00Z', {
      overrides: [makeOverride({ occurrenceKey: '2025-06-03', cancelled: true })],
    });
    expect(result.map((item) => item.startAt)).toEqual(['2025-06-02', '2025-06-04']);
  });
});

describe('序列拆分辅助', () => {
  const rule: RecurrenceRule = { freq: 'WEEKLY', interval: 2, count: 10 };

  it('seriesIndexBefore 统计拆分点之前已发生的次数', () => {
    expect(seriesIndexBefore(rule, '2025-06-02', SHANGHAI, '2025-06-02')).toBe(0);
    expect(seriesIndexBefore(rule, '2025-06-02', SHANGHAI, '2025-06-16')).toBe(1);
    expect(seriesIndexBefore(rule, '2025-06-02', SHANGHAI, '2025-07-14')).toBe(3);
  });

  it('truncateUntilKeyFor 生成拆分前一天作为截断边界', () => {
    expect(truncateUntilKeyFor('2025-06-16T01:00:00.000Z', false, SHANGHAI)).toBe('2025-06-15');
    expect(truncateUntilKeyFor('2025-06-16', true, SHANGHAI)).toBe('2025-06-15');
  });
});

describe('重复规则文案', () => {
  it('生成可读的中文描述', () => {
    expect(describeRecurrence(null)).toBe('不重复');
    expect(describeRecurrence({ freq: 'DAILY', interval: 1 })).toBe('每天');
    expect(describeRecurrence({ freq: 'DAILY', interval: 3 })).toBe('每 3 天');
    expect(describeRecurrence({ freq: 'WEEKLY', interval: 1, byWeekday: [1, 3] })).toBe('每周 周一、周三');
    expect(describeRecurrence({ freq: 'WEEKLY', interval: 2, byWeekday: [5] })).toBe('每 2 周 周五');
    expect(describeRecurrence({ freq: 'MONTHLY', interval: 1, count: 6 })).toBe('每月，共 6 次');
    expect(describeRecurrence({ freq: 'YEARLY', interval: 1, until: '2030-01-01' })).toBe('每年，至 2030-01-01');
  });
});
