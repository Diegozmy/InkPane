import { describe, expect, it } from 'vitest';
import {
  addMinutesToTime,
  buildEventPayload,
  buildRecurrenceRule,
  combineLocal,
  createEmptyFormState,
  formStateFromOccurrence,
  shiftSeriesTimes,
  splitInstant,
  type EventFormState,
} from './form-state';
import type { CalendarEvent, Occurrence } from '@/types';

function baseState(partial: Partial<EventFormState> = {}): EventFormState {
  return {
    ...createEmptyFormState({
      startAt: new Date(2025, 5, 2, 9, 0).toISOString(),
      endAt: new Date(2025, 5, 2, 10, 0).toISOString(),
      allDay: false,
    }),
    title: '项目评审',
    ...partial,
  };
}

describe('时间字符串处理', () => {
  it('在分钟数上安全地加减并跨天回绕', () => {
    expect(addMinutesToTime('09:00', 30)).toBe('09:30');
    expect(addMinutesToTime('09:45', 30)).toBe('10:15');
    expect(addMinutesToTime('23:30', 60)).toBe('00:30');
  });

  it('日期 + 时间组合成本地瞬间', () => {
    const iso = combineLocal('2025-06-02', '09:30');
    const date = new Date(iso);
    expect(date.getFullYear()).toBe(2025);
    expect(date.getMonth()).toBe(5);
    expect(date.getDate()).toBe(2);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(30);
  });

  it('拆分瞬间得到本地日期与时间', () => {
    const { date, time } = splitInstant(combineLocal('2025-06-02', '14:05'));
    expect(date).toBe('2025-06-02');
    expect(time).toBe('14:05');
  });
});

describe('表单初始值', () => {
  it('新建定时日程时默认时长一小时，并把开始日的星期设为重复默认值', () => {
    // 2025-06-02 是周一
    const state = createEmptyFormState({
      startAt: new Date(2025, 5, 2, 9, 0).toISOString(),
      endAt: new Date(2025, 5, 2, 10, 0).toISOString(),
      allDay: false,
    });
    expect(state.allDay).toBe(false);
    expect(state.startDate).toBe('2025-06-02');
    expect(state.byWeekday).toEqual([1]);
    expect(state.recurrenceEnabled).toBe(false);
    expect(state.priority).toBe('normal');
  });

  it('编辑已有的重复实例时还原出规则设置', () => {
    const occurrence: Occurrence = {
      id: '1:x',
      eventId: 1,
      occurrenceKey: 'x',
      title: '周会',
      description: '同步进度',
      location: '三号会议室',
      categoryId: 3,
      priority: 'high',
      status: 'confirmed',
      allDay: false,
      startAt: new Date(2025, 5, 9, 10, 0).toISOString(),
      endAt: new Date(2025, 5, 9, 11, 0).toISOString(),
      timezone: 'Asia/Shanghai',
      tags: ['例行'],
      color: null,
      remindMinutesBefore: 15,
      isRecurring: true,
      isModified: false,
      rrule: { freq: 'WEEKLY', interval: 2, byWeekday: [1, 3], count: 6 },
    };
    const state = formStateFromOccurrence(occurrence, null);
    expect(state.title).toBe('周会');
    expect(state.recurrenceEnabled).toBe(true);
    expect(state.freq).toBe('WEEKLY');
    expect(state.interval).toBe(2);
    expect(state.byWeekday).toEqual([1, 3]);
    expect(state.recurrenceEnd).toBe('count');
    expect(state.count).toBe(6);
    expect(state.tags).toEqual(['例行']);
  });
});

describe('表单校验', () => {
  it('标题为空时拒绝提交', () => {
    const result = buildEventPayload(baseState({ title: '   ' }));
    expect(result.payload).toBeNull();
    expect(result.error).toContain('标题');
  });

  it('结束时间不晚于开始时间时拒绝提交', () => {
    const result = buildEventPayload(baseState({ startTime: '10:00', endTime: '09:00' }));
    expect(result.payload).toBeNull();
    expect(result.error).toContain('结束时间');
  });

  it('全天日程允许同一天开始与结束', () => {
    const result = buildEventPayload(
      baseState({ allDay: true, startDate: '2025-06-02', endDate: '2025-06-02' }),
    );
    expect(result.payload).toMatchObject({ startAt: '2025-06-02', endAt: '2025-06-02', allDay: true });
  });

  it('全天日程的结束日期早于开始日期时拒绝提交', () => {
    const result = buildEventPayload(
      baseState({ allDay: true, startDate: '2025-06-05', endDate: '2025-06-02' }),
    );
    expect(result.payload).toBeNull();
  });

  it('合法的定时日程产出 ISO 时间与请求时区', () => {
    const result = buildEventPayload(baseState());
    expect(result.error).toBeNull();
    expect(result.payload?.startAt).toBe(new Date(2025, 5, 2, 9, 0).toISOString());
    expect(result.payload?.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(result.payload?.tags).toEqual([]);
  });

  it('标签会去掉空白并过滤空值', () => {
    const result = buildEventPayload(baseState({ tags: [' 客户 ', '', '   '] }));
    expect(result.payload?.tags).toEqual(['客户']);
  });
});

describe('重复规则构造', () => {
  it('未开启重复时返回 null', () => {
    expect(buildRecurrenceRule(baseState())).toBeNull();
  });

  it('每周重复会带上选中的星期', () => {
    const rule = buildRecurrenceRule(
      baseState({ recurrenceEnabled: true, freq: 'WEEKLY', byWeekday: [5, 1, 1] }),
    );
    expect(rule).toEqual({ freq: 'WEEKLY', interval: 1, byWeekday: [1, 5] });
  });

  it('每周重复未选星期时回退到周一', () => {
    const rule = buildRecurrenceRule(baseState({ recurrenceEnabled: true, freq: 'WEEKLY', byWeekday: [] }));
    expect(rule).toMatchObject({ byWeekday: [1] });
  });

  it('按次数结束时写入 count 而不是 until', () => {
    const rule = buildRecurrenceRule(
      baseState({ recurrenceEnabled: true, freq: 'DAILY', recurrenceEnd: 'count', count: 12 }),
    );
    expect(rule).toMatchObject({ freq: 'DAILY', interval: 1, count: 12 });
    expect(rule?.until).toBeUndefined();
  });

  it('按日期结束时写入 until', () => {
    const rule = buildRecurrenceRule(
      baseState({ recurrenceEnabled: true, freq: 'MONTHLY', recurrenceEnd: 'until', until: '2026-01-31' }),
    );
    expect(rule).toMatchObject({ freq: 'MONTHLY', until: '2026-01-31' });
  });

  it('间隔会被限制在 1 到 365 之间', () => {
    const rule = buildRecurrenceRule(baseState({ recurrenceEnabled: true, interval: 9999 }));
    expect(rule?.interval).toBe(365);
  });
});

describe('整条序列的时间平移', () => {
  const master: CalendarEvent = {
    id: 1,
    title: '周会',
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
    rrule: { freq: 'WEEKLY', interval: 1 },
    color: null,
    remindMinutesBefore: null,
    createdAt: '',
    updatedAt: '',
  };

  const occurrence: Occurrence = {
    id: '1:x',
    eventId: 1,
    occurrenceKey: 'x',
    title: '周会',
    description: '',
    location: '',
    categoryId: null,
    priority: 'normal',
    status: 'confirmed',
    allDay: false,
    startAt: new Date(2025, 5, 16, 9, 0).toISOString(),
    endAt: new Date(2025, 5, 16, 10, 0).toISOString(),
    timezone: 'Asia/Shanghai',
    tags: [],
    color: null,
    remindMinutesBefore: null,
    isRecurring: true,
    isModified: false,
    rrule: { freq: 'WEEKLY', interval: 1 },
  };

  it('把某个实例的时间差套用到整条序列，而不是把首日搬过去', () => {
    const payload = buildEventPayload(
      baseState({
        title: '周会',
        startDate: '2025-06-16',
        startTime: '11:00',
        endDate: '2025-06-16',
        endTime: '12:00',
      }),
    );
    expect(payload.payload).not.toBeNull();

    const shifted = shiftSeriesTimes(master, occurrence, payload.payload as NonNullable<typeof payload.payload>);
    expect(new Date(shifted.startAt).getHours()).toBe(11);
    // 序列首日仍然是 06-02，只是整体平移了 2 小时
    expect(new Date(shifted.startAt).getDate()).toBe(2);
    expect(new Date(shifted.endAt).getHours()).toBe(12);
  });

  it('全天序列按天数平移', () => {
    const allDayMaster: CalendarEvent = {
      ...master,
      allDay: true,
      startAt: '2025-06-02',
      endAt: '2025-06-04',
      rrule: { freq: 'WEEKLY', interval: 1 },
    };
    const allDayOccurrence: Occurrence = {
      ...occurrence,
      allDay: true,
      startAt: '2025-06-16',
      endAt: '2025-06-18',
    };
    const payload = buildEventPayload(
      baseState({ allDay: true, startDate: '2025-06-23', endDate: '2025-06-25' }),
    );
    const shifted = shiftSeriesTimes(
      allDayMaster,
      allDayOccurrence,
      payload.payload as NonNullable<typeof payload.payload>,
    );
    expect(shifted.startAt).toBe('2025-06-09');
    expect(shifted.endAt).toBe('2025-06-11');
  });
});
