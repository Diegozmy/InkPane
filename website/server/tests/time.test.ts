import { describe, expect, it } from 'vitest';
import {
  addDaysToDateKey,
  addMonthsToDateKey,
  dateKeyAndMinutesToInstant,
  diffInDays,
  endOfMonthDateKey,
  instantToZonedParts,
  isLeapYear,
  isValidDateKey,
  isValidTimeZone,
  minutesFromMidnight,
  startOfWeekDateKey,
  toDateKey,
  wallTimeToInstant,
} from '../src/domain/time.js';

describe('时区工具', () => {
  it('能识别非法的 IANA 时区标识', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('墙上时间与瞬间可以互相往返（无夏令时的时区）', () => {
    const instant = wallTimeToInstant(
      { year: 2025, month: 6, day: 2, hour: 9, minute: 30 },
      'Asia/Shanghai',
    );
    expect(instant.toISOString()).toBe('2025-06-02T01:30:00.000Z');

    const parts = instantToZonedParts(instant, 'Asia/Shanghai');
    expect(parts).toMatchObject({ year: 2025, month: 6, day: 2, hour: 9, minute: 30 });
  });

  it('跨夏令时切换仍能还原正确的墙上时间', () => {
    // 2025-03-09 是美东夏令时开始日；01:30 仍属于 EST
    const beforeDst = wallTimeToInstant(
      { year: 2025, month: 3, day: 9, hour: 1, minute: 30 },
      'America/New_York',
    );
    expect(beforeDst.toISOString()).toBe('2025-03-09T06:30:00.000Z');

    // 03:30 已进入 EDT（UTC-4）
    const afterDst = wallTimeToInstant(
      { year: 2025, month: 3, day: 9, hour: 3, minute: 30 },
      'America/New_York',
    );
    expect(afterDst.toISOString()).toBe('2025-03-09T07:30:00.000Z');
  });

  it('按瞬间换算出所在时区的日期串', () => {
    const instant = new Date('2025-06-01T20:00:00.000Z');
    expect(toDateKey(instant, 'Asia/Shanghai')).toBe('2025-06-02');
    expect(toDateKey(instant, 'America/New_York')).toBe('2025-06-01');
    expect(toDateKey(instant, 'UTC')).toBe('2025-06-01');
  });

  it('日期串运算保持日历语义', () => {
    expect(addDaysToDateKey('2025-02-28', 1)).toBe('2025-03-01');
    expect(addDaysToDateKey('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDaysToDateKey('2025-01-01', -1)).toBe('2024-12-31');
    expect(addMonthsToDateKey('2025-01-31', 1)).toBe('2025-02-28');
    expect(diffInDays('2025-01-01', '2025-03-01')).toBe(59);
    expect(endOfMonthDateKey('2024-02-10')).toBe('2024-02-29');
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it('校验日期串是否真实存在', () => {
    expect(isValidDateKey('2025-02-28')).toBe(true);
    expect(isValidDateKey('2025-02-30')).toBe(false);
    expect(isValidDateKey('2025-13-01')).toBe(false);
    expect(isValidDateKey('2025-2-1')).toBe(false);
    expect(isValidDateKey('abc')).toBe(false);
  });

  it('周一为一周起点', () => {
    // 2025-06-02 是周一
    expect(startOfWeekDateKey('2025-06-02', 1)).toBe('2025-06-02');
    expect(startOfWeekDateKey('2025-06-08', 1)).toBe('2025-06-02');
    expect(startOfWeekDateKey('2025-06-01', 1)).toBe('2025-05-26');
    expect(startOfWeekDateKey('2025-06-01', 0)).toBe('2025-06-01');
  });

  it('日期串 + 分钟数可组合出瞬间', () => {
    const instant = dateKeyAndMinutesToInstant('2025-06-02', 9 * 60 + 15, 'Asia/Shanghai');
    expect(instant.toISOString()).toBe('2025-06-02T01:15:00.000Z');
    expect(minutesFromMidnight(instant, 'Asia/Shanghai')).toBe(555);
  });
});
