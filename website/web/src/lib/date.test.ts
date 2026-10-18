import { describe, expect, it } from 'vitest';
import {
  addDaysToDateKey,
  clampMinutes,
  dateAtMinutes,
  formatDuration,
  formatTime,
  fromDateKey,
  isDateKey,
  isWeekend,
  minutesFromMidnight,
  monthGridRange,
  occurrenceCoversDay,
  relativeDayLabel,
  snapMinutes,
  toDateKey,
  weekRange,
} from './date';
import type { Occurrence } from '@/types';

function makeOccurrence(partial: Partial<Occurrence>): Occurrence {
  return {
    id: '1:key',
    eventId: 1,
    occurrenceKey: 'key',
    title: '测试',
    description: '',
    location: '',
    categoryId: null,
    priority: 'normal',
    status: 'confirmed',
    allDay: false,
    startAt: '2025-06-02T01:00:00.000Z',
    endAt: '2025-06-02T02:00:00.000Z',
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

describe('日期键与本地时间互转', () => {
  it('日期键可以无损往返', () => {
    const key = '2025-06-02';
    expect(toDateKey(fromDateKey(key))).toBe(key);
    expect(fromDateKey('2025-06-02').getHours()).toBe(0);
  });

  it('addDaysToDateKey 处理跨月与跨年', () => {
    expect(addDaysToDateKey('2025-01-31', 1)).toBe('2025-02-01');
    expect(addDaysToDateKey('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDaysToDateKey('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDaysToDateKey('2025-03-01', -1)).toBe('2025-02-28');
  });

  it('isDateKey 只接受严格的 YYYY-MM-DD', () => {
    expect(isDateKey('2025-06-02')).toBe(true);
    expect(isDateKey('2025-6-2')).toBe(false);
    expect(isDateKey('2025-06-02T00:00:00Z')).toBe(false);
    expect(isDateKey(undefined)).toBe(false);
  });

  it('isWeekend 只把周六周日算作周末', () => {
    expect(isWeekend(fromDateKey('2025-06-07'))).toBe(true); // 周六
    expect(isWeekend(fromDateKey('2025-06-08'))).toBe(true); // 周日
    expect(isWeekend(fromDateKey('2025-06-09'))).toBe(false); // 周一
  });
});

describe('视图区间计算', () => {
  it('周视图固定 7 天且从周一开始', () => {
    const { from, to, days } = weekRange(fromDateKey('2025-06-05')); // 周四
    expect(toDateKey(from)).toBe('2025-06-02');
    expect(toDateKey(new Date(to.getTime() - 1))).toBe('2025-06-08');
    expect(days).toHaveLength(7);
  });

  it('月视图网格以周一开头、周日结尾并覆盖整月', () => {
    const { days } = monthGridRange(fromDateKey('2025-06-15'));
    expect(days.length % 7).toBe(0);
    expect(days[0]?.getDay()).toBe(1); // 周一
    expect(days[days.length - 1]?.getDay()).toBe(0); // 周日
    expect(days.some((day) => toDateKey(day) === '2025-06-01')).toBe(true);
    expect(days.some((day) => toDateKey(day) === '2025-06-30')).toBe(true);
  });

  it('月视图网格能覆盖月初/月末落在周中间的情况', () => {
    // 2025-06-01 是周日，因此网格需要包含 5 月末的日期
    const { days } = monthGridRange(fromDateKey('2025-06-01'));
    expect(toDateKey(days[0] as Date)).toBe('2025-05-26');
  });
});

describe('时间换算', () => {
  it('分钟数吸附到 15 分钟网格', () => {
    expect(snapMinutes(0)).toBe(0);
    expect(snapMinutes(7)).toBe(0);
    expect(snapMinutes(8)).toBe(15);
    expect(snapMinutes(37, 30)).toBe(30);
    expect(snapMinutes(46, 30)).toBe(60);
  });

  it('分钟数被限制在一天之内', () => {
    expect(clampMinutes(-10)).toBe(0);
    expect(clampMinutes(1440)).toBe(1440);
    expect(clampMinutes(2000)).toBe(1440);
  });

  it('可以从当天分钟数构造时间', () => {
    const date = dateAtMinutes(fromDateKey('2025-06-02'), 9 * 60 + 30);
    expect(minutesFromMidnight(date)).toBe(570);
    expect(formatTime(date)).toBe('09:30');
    expect(formatTime(dateAtMinutes(fromDateKey('2025-06-02'), 600))).toBe('10:00');
  });

  it('时长文案按小时/分钟组合', () => {
    expect(formatDuration(0)).toBe('0 分钟');
    expect(formatDuration(45)).toBe('45 分钟');
    expect(formatDuration(60)).toBe('1 小时');
    expect(formatDuration(90)).toBe('1 小时 30 分钟');
  });

  it('相对日期文案会区分今天/明天/昨天', () => {
    const today = new Date(2025, 5, 2, 10, 0, 0);
    expect(relativeDayLabel(new Date(2025, 5, 2), today)).toBe('今天');
    expect(relativeDayLabel(new Date(2025, 5, 3), today)).toBe('明天');
    expect(relativeDayLabel(new Date(2025, 5, 1), today)).toBe('昨天');
    expect(relativeDayLabel(new Date(2025, 5, 6), today)).toBe('4 天后');
  });
});

describe('事件覆盖某一天', () => {
  it('全天事件覆盖起止日期之间的每一天', () => {
    const occurrence = makeOccurrence({
      allDay: true,
      startAt: '2025-06-02',
      endAt: '2025-06-04',
    });
    expect(occurrenceCoversDay(occurrence, fromDateKey('2025-06-02'))).toBe(true);
    expect(occurrenceCoversDay(occurrence, fromDateKey('2025-06-03'))).toBe(true);
    expect(occurrenceCoversDay(occurrence, fromDateKey('2025-06-04'))).toBe(true);
    expect(occurrenceCoversDay(occurrence, fromDateKey('2025-06-05'))).toBe(false);
  });

  it('跨夜事件同时覆盖两天', () => {
    const occurrence = makeOccurrence({
      startAt: new Date(2025, 5, 2, 23, 0, 0).toISOString(),
      endAt: new Date(2025, 5, 3, 1, 0, 0).toISOString(),
    });
    expect(occurrenceCoversDay(occurrence, new Date(2025, 5, 2))).toBe(true);
    expect(occurrenceCoversDay(occurrence, new Date(2025, 5, 3))).toBe(true);
    expect(occurrenceCoversDay(occurrence, new Date(2025, 5, 4))).toBe(false);
  });
});
