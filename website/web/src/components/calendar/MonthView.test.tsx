// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MonthView } from './MonthView';
import type { Category, Occurrence } from '@/types';

function occurrence(id: string, day: number, title: string, hour = 9): Occurrence {
  return {
    id,
    eventId: 1,
    occurrenceKey: id,
    title,
    description: '',
    location: '',
    categoryId: null,
    priority: 'normal',
    status: 'confirmed',
    allDay: false,
    startAt: new Date(2025, 5, day, hour, 0).toISOString(),
    endAt: new Date(2025, 5, day, hour + 1, 0).toISOString(),
    timezone: 'Asia/Shanghai',
    tags: [],
    color: null,
    remindMinutesBefore: null,
    isRecurring: false,
    isModified: false,
    rrule: null,
  };
}

const CATEGORIES = new Map<number, Category>();

const DAYS = [
  new Date(2025, 4, 26),
  new Date(2025, 4, 27),
  new Date(2025, 4, 28),
  new Date(2025, 4, 29),
  new Date(2025, 4, 30),
  new Date(2025, 4, 31),
  new Date(2025, 5, 1),
  new Date(2025, 5, 2),
  new Date(2025, 5, 3),
  new Date(2025, 5, 4),
  new Date(2025, 5, 5),
  new Date(2025, 5, 6),
  new Date(2025, 5, 7),
  new Date(2025, 5, 8),
];

function renderMonth(occurrences: Occurrence[], chipsPerDay = 4) {
  const onSelect = vi.fn();
  const onOpenDay = vi.fn();
  const onCreateAllDay = vi.fn();
  const onMoveToDay = vi.fn();

  render(
    <MonthView
      days={DAYS}
      anchor={new Date(2025, 5, 2)}
      occurrences={occurrences}
      categoriesById={CATEGORIES}
      isDark={false}
      selectedId={null}
      chipsPerDay={chipsPerDay}
      onSelect={onSelect}
      onOpenDay={onOpenDay}
      onCreateAllDay={onCreateAllDay}
      onMoveToDay={onMoveToDay}
    />,
  );

  return { onSelect, onOpenDay, onCreateAllDay, onMoveToDay };
}

describe('月视图渲染', () => {
  it('渲染星期表头与当月日期', () => {
    renderMonth([]);
    expect(screen.getByText('周一')).toBeTruthy();
    expect(screen.getByText('周日')).toBeTruthy();
    expect(screen.getAllByRole('gridcell')).toHaveLength(DAYS.length);
  });

  it('渲染事件的标题与时间', () => {
    renderMonth([occurrence('a', 2, '项目评审')]);
    expect(screen.getByText('项目评审')).toBeTruthy();
  });

  it('点击事件条目会回调 onSelect', () => {
    const { onSelect } = renderMonth([occurrence('a', 2, '项目评审')]);
    fireEvent.click(screen.getByText('项目评审'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ id: 'a' });
  });

  it('超出上限时折叠并显示「还有 N 项」，展开后全部可见', () => {
    renderMonth(
      [
        occurrence('a', 2, '日程 A', 9),
        occurrence('b', 2, '日程 B', 10),
        occurrence('c', 2, '日程 C', 11),
      ],
      2,
    );

    expect(screen.queryByText('日程 C')).toBeNull();
    const more = screen.getByText('还有 1 项');
    fireEvent.click(more);
    expect(screen.getByText('日程 C')).toBeTruthy();
    expect(screen.getByText('收起')).toBeTruthy();
  });

  it('没有安排的日期给出可发现的空状态提示', () => {
    renderMonth([]);
    expect(screen.getAllByText(/双击新建全天/).length).toBeGreaterThan(0);
  });

  it('双击日期单元格会创建全天日程', () => {
    const { onCreateAllDay } = renderMonth([]);
    const cell = screen.getAllByRole('gridcell')[7];
    expect(cell).toBeTruthy();
    fireEvent.doubleClick(cell as HTMLElement);
    expect(onCreateAllDay).toHaveBeenCalledTimes(1);
  });
});
