import { describe, expect, it } from 'vitest';
import type { Category, Occurrence } from '@/types';
import {
  buildMonthBuckets,
  eventColorOf,
  isOccurrencePast,
  layoutTimedEvents,
  rangeBlockStyle,
} from './calendar-utils';

function occurrence(partial: Partial<Occurrence> & { id: string }): Occurrence {
  return {
    eventId: 1,
    occurrenceKey: partial.id,
    title: '日程',
    description: '',
    location: '',
    categoryId: null,
    priority: 'normal',
    status: 'confirmed',
    allDay: false,
    startAt: new Date(2025, 5, 2, 9, 0).toISOString(),
    endAt: new Date(2025, 5, 2, 10, 0).toISOString(),
    timezone: 'Asia/Shanghai',
    tags: [],
    color: null,
    remindMinutesBefore: null,
    isRecurring: false,
    isModified: false,
    rrule: null,
    ...partial,
  };
}

const DAY = new Date(2025, 5, 2);

describe('时间轴列布局', () => {
  it('不重叠的事件各自占满整行宽度', () => {
    const result = layoutTimedEvents(
      [
        occurrence({ id: 'a', startAt: new Date(2025, 5, 2, 9, 0).toISOString(), endAt: new Date(2025, 5, 2, 10, 0).toISOString() }),
        occurrence({ id: 'b', startAt: new Date(2025, 5, 2, 11, 0).toISOString(), endAt: new Date(2025, 5, 2, 12, 0).toISOString() }),
      ],
      DAY,
    );
    expect(result).toHaveLength(2);
    expect(result.every((item) => item.columnCount === 1)).toBe(true);
    expect(result.every((item) => item.widthPercent === 100)).toBe(true);
  });

  it('时间重叠的事件并排分列而不是互相遮挡', () => {
    const result = layoutTimedEvents(
      [
        occurrence({ id: 'a', startAt: new Date(2025, 5, 2, 9, 0).toISOString(), endAt: new Date(2025, 5, 2, 10, 0).toISOString() }),
        occurrence({ id: 'b', startAt: new Date(2025, 5, 2, 9, 30).toISOString(), endAt: new Date(2025, 5, 2, 10, 30).toISOString() }),
      ],
      DAY,
    );
    expect(result.map((item) => item.columnIndex).sort()).toEqual([0, 1]);
    expect(result.every((item) => item.columnCount === 2)).toBe(true);
    expect(result.every((item) => item.widthPercent === 50)).toBe(true);
  });

  it('被长事件包住的事件会继续向右分列', () => {
    const result = layoutTimedEvents(
      [
        occurrence({ id: 'long', startAt: new Date(2025, 5, 2, 9, 0).toISOString(), endAt: new Date(2025, 5, 2, 12, 0).toISOString() }),
        occurrence({ id: 'short', startAt: new Date(2025, 5, 2, 10, 0).toISOString(), endAt: new Date(2025, 5, 2, 11, 0).toISOString() }),
      ],
      DAY,
    );
    const long = result.find((item) => item.occurrence.id === 'long');
    const short = result.find((item) => item.occurrence.id === 'short');
    expect(long?.columnCount).toBe(2);
    expect(short?.columnIndex).toBe(1);
  });

  it('全天事件不参与时间轴布局', () => {
    const result = layoutTimedEvents(
      [occurrence({ id: 'all', allDay: true, startAt: '2025-06-02', endAt: '2025-06-02' })],
      DAY,
    );
    expect(result).toHaveLength(0);
  });

  it('跨夜事件在当天被裁剪到 0 点起始', () => {
    const result = layoutTimedEvents(
      [
        occurrence({
          id: 'overnight',
          startAt: new Date(2025, 5, 1, 23, 0).toISOString(),
          endAt: new Date(2025, 5, 2, 1, 0).toISOString(),
        }),
      ],
      DAY,
    );
    expect(result[0]?.startMinutes).toBe(0);
    expect(result[0]?.endMinutes).toBe(60);
    expect(result[0]?.continuesFromPreviousDay).toBe(true);
  });

  it('极短事件也会保留最小可视高度', () => {
    const result = layoutTimedEvents(
      [
        occurrence({
          id: 'tiny',
          startAt: new Date(2025, 5, 2, 9, 0).toISOString(),
          endAt: new Date(2025, 5, 2, 9, 5).toISOString(),
        }),
      ],
      DAY,
    );
    expect((result[0]?.endMinutes ?? 0) - (result[0]?.startMinutes ?? 0)).toBeGreaterThanOrEqual(15);
  });

  it('定位样式输出 CSS 变量而不是像素值', () => {
    const style = rangeBlockStyle(540, 600, 0, 50) as Record<string, string>;
    expect(style['--block-top']).toBe('calc(var(--minute-height) * 540)');
    expect(style['--block-width']).toBe('calc(50% - 3px)');
  });
});

describe('月视图分桶', () => {
  const days = [new Date(2025, 5, 2), new Date(2025, 5, 3), new Date(2025, 5, 4)];

  it('多天全天事件会出现在它覆盖的每一天', () => {
    const buckets = buildMonthBuckets(
      [occurrence({ id: 'trip', allDay: true, startAt: '2025-06-02', endAt: '2025-06-04' })],
      days,
    );
    expect(buckets.get('2025-06-02')).toHaveLength(1);
    expect(buckets.get('2025-06-03')).toHaveLength(1);
    expect(buckets.get('2025-06-04')).toHaveLength(1);
    expect(buckets.get('2025-06-02')?.[0]).toMatchObject({ isStart: true, isEnd: false });
    expect(buckets.get('2025-06-04')?.[0]).toMatchObject({ isStart: false, isEnd: true });
  });

  it('不覆盖该天的事件不会进入该天的桶', () => {
    const buckets = buildMonthBuckets([occurrence({ id: 'single' })], days);
    expect(buckets.get('2025-06-02')).toHaveLength(1);
    expect(buckets.get('2025-06-03')).toHaveLength(0);
  });

  it('桶内顺序固定：全天在前，其余按开始时间升序', () => {
    const buckets = buildMonthBuckets(
      [
        occurrence({ id: 'afternoon', startAt: new Date(2025, 5, 2, 14, 0).toISOString(), endAt: new Date(2025, 5, 2, 15, 0).toISOString() }),
        occurrence({ id: 'all', allDay: true, startAt: '2025-06-02', endAt: '2025-06-02' }),
        occurrence({ id: 'morning', startAt: new Date(2025, 5, 2, 8, 0).toISOString(), endAt: new Date(2025, 5, 2, 9, 0).toISOString() }),
      ],
      [new Date(2025, 5, 2)],
    );
    expect(buckets.get('2025-06-02')?.map((entry) => entry.occurrence.id)).toEqual([
      'all',
      'morning',
      'afternoon',
    ]);
  });
});

describe('事件配色与过期判断', () => {
  const categories = new Map<number, Category>([
    [
      7,
      {
        id: 7,
        name: '工作',
        color: '#3b6fd4',
        icon: null,
        sortOrder: 0,
        createdAt: '',
        updatedAt: '',
      },
    ],
  ]);

  it('优先使用事件自身颜色，其次分类颜色，最后回退默认色', () => {
    expect(eventColorOf(occurrence({ id: 'a', color: '#ff0000', categoryId: 7 }), categories)).toBe('#ff0000');
    expect(eventColorOf(occurrence({ id: 'b', categoryId: 7 }), categories)).toBe('#3b6fd4');
    expect(eventColorOf(occurrence({ id: 'c' }), categories)).toBe('#5b6b7f');
  });

  it('已经结束的事件被判定为过期', () => {
    const past = occurrence({
      id: 'past',
      startAt: new Date(2020, 0, 1, 9, 0).toISOString(),
      endAt: new Date(2020, 0, 1, 10, 0).toISOString(),
    });
    const future = occurrence({
      id: 'future',
      startAt: new Date(2999, 0, 1, 9, 0).toISOString(),
      endAt: new Date(2999, 0, 1, 10, 0).toISOString(),
    });
    expect(isOccurrencePast(past)).toBe(true);
    expect(isOccurrencePast(future)).toBe(false);
  });
});
