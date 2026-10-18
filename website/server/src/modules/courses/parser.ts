/**
 * 课表 HTML 解析器。
 *
 * 真实结构（ws8.yucai.sh.cn /Xskebiao 返回的 info.html，已实测确认）：
 *
 *   <select id="xuecheng">
 *     <option value="102" selected>2026-2027学年第一学程</option> …
 *   </select>
 *   <table>
 *     <tr><td></td><td>星期日(2026-10-11)</td><td>星期一(2026-10-12)</td> … <td>星期六(2026-10-17)</td></tr>
 *     <tr class="odd">
 *       <td>第一节</td>
 *       <td class="spec_td"></td>
 *       <td class="spec_td"><span><div>高三语文1-1</div><div>朱英杰</div><div>301</div></span></td>
 *       …
 *     </tr>
 *     …
 *   </table>
 *
 * 即：第 0 列是节次，第 1..7 列是星期日..星期六；单元格里依次是 课程名 / 教师 / 教室。
 * 表头通常带真实日期，可用于推导当周与默认学期起始日。
 */

import type { SchoolSlot, SchoolTimetable } from './client.js';
import { SchoolPortalError } from './client.js';

const WEEKDAY_BY_CHAR: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};

const CN_DIGITS: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 把「第一节」「第10节」「第 十 节」都解析成数字；解析不出返回 null。 */
export function parsePeriodNumber(label: string): number | null {
  const text = label.replace(/\s/g, '');
  const arabic = /^第?(\d{1,2})节?$/.exec(text) ?? /第(\d{1,2})节/.exec(text);
  if (arabic?.[1]) {
    const value = Number(arabic[1]);
    return Number.isFinite(value) && value > 0 && value <= 30 ? value : null;
  }

  const chinese = /第([〇零一二两三四五六七八九十]+)节/.exec(text);
  if (!chinese?.[1]) return null;
  const digits = chinese[1];
  if (digits === '十') return 10;
  if (digits.startsWith('十')) {
    const rest = CN_DIGITS[digits.slice(1)] ?? 0;
    return 10 + rest;
  }
  const tenIndex = digits.indexOf('十');
  if (tenIndex >= 0) {
    const tens = CN_DIGITS[digits.slice(0, tenIndex)] ?? 0;
    const ones = digits.slice(tenIndex + 1);
    return tens * 10 + (ones.length > 0 ? (CN_DIGITS[ones] ?? 0) : 0);
  }
  return CN_DIGITS[digits] ?? null;
}

/** 「星期一」「周一」「星期天」→ 1..7（周一=1，周日=7）。 */
export function parseWeekday(label: string): number | null {
  const match = /(?:星期|周)([一二三四五六日天])/.exec(label);
  if (!match?.[1]) return null;
  return WEEKDAY_BY_CHAR[match[1]] ?? null;
}

interface Cell {
  html: string;
  text: string;
  column: number;
  colspan: number;
}

/** 抽出表格行；按 colspan 计算每一列的真实列号（rowspan 在该表中未出现，故不处理）。 */
function parseRows(html: string): Cell[][] {
  const rows: Cell[][] = [];
  const rowMatches = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const rowMatch of rowMatches) {
    const rowHtml = rowMatch[1] ?? '';
    const cells: Cell[] = [];
    let column = 0;
    for (const cellMatch of rowHtml.matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      const attributes = cellMatch[1] ?? '';
      const inner = cellMatch[2] ?? '';
      const colspan = Math.max(1, Number(/colspan\s*=\s*["']?(\d+)/i.exec(attributes)?.[1] ?? 1));
      cells.push({ html: inner, text: stripTags(inner), column, colspan });
      column += colspan;
    }
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

/** 单元格里的课程信息：依次是 课程名 / 教师 / 教室，也可能只有一两项。 */
function parseSlotCell(html: string): { courseName: string; teacher: string; room: string } | null {
  const divs = [...html.matchAll(/<div[^>]*>([\s\S]*?)<\/div>/gi)]
    .map((match) => stripTags(match[1] ?? ''))
    .filter((text) => text.length > 0);

  const parts = divs.length > 0 ? divs : stripTags(html).split(/\s{2,}|／|\//).filter(Boolean);
  const [courseName = '', teacher = '', room = ''] = parts;
  if (courseName.trim().length === 0) return null;
  return { courseName: courseName.trim(), teacher: teacher.trim(), room: room.trim() };
}

export interface ParseResult {
  termId: string | null;
  termName: string | null;
  weekDates: { weekday: number; dateKey: string }[];
  periodNumbers: number[];
  slots: SchoolSlot[];
}

export function parseTimetableHtml(html: string): ParseResult {
  /* ---- 学程 ---- */
  const selectHtml = /<select[^>]*id=["']xuecheng["'][^>]*>([\s\S]*?)<\/select>/i.exec(html)?.[1] ?? '';
  const options = [...selectHtml.matchAll(/<option[^>]*value=["']([^"']*)["']([^>]*)>([\s\S]*?)<\/option>/gi)];
  let termId: string | null = null;
  let termName: string | null = null;
  for (const option of options) {
    if (/selected/i.test(option[2] ?? '')) {
      termId = option[1] ?? null;
      termName = stripTags(option[3] ?? '');
      break;
    }
  }

  /* ---- 表头：列号 → 星期 / 日期 ---- */
  const rows = parseRows(html);
  const columnToWeekday = new Map<number, number>();
  const weekDates: { weekday: number; dateKey: string }[] = [];

  for (const row of rows) {
    let matched = 0;
    for (const cell of row) {
      const weekday = parseWeekday(cell.text);
      if (weekday === null) continue;
      matched += 1;
      columnToWeekday.set(cell.column, weekday);
      const dateKey = /(\d{4})-(\d{2})-(\d{2})/.exec(cell.text)?.[0];
      if (dateKey) weekDates.push({ weekday, dateKey });
    }
    if (matched >= 5) break; // 找到真正的表头行
  }

  /* ---- 数据行 ---- */
  const slots: SchoolSlot[] = [];
  const periodSet = new Set<number>();

  for (const row of rows) {
    const labelCell = row[0];
    if (!labelCell) continue;
    const period = parsePeriodNumber(labelCell.text);
    if (period === null) continue;
    periodSet.add(period);

    for (const cell of row.slice(1)) {
      // 没有表头时按「第 1 列 = 周一」兜底
      const weekday = columnToWeekday.get(cell.column) ?? (cell.column >= 1 && cell.column <= 7 ? cell.column : null);
      if (weekday === null) continue;
      const info = parseSlotCell(cell.html);
      if (!info) continue;
      slots.push({ weekday, period, ...info });
    }
  }

  if (slots.length === 0 && periodSet.size === 0) {
    throw new SchoolPortalError(
      'parse',
      '课表中没有解析到任何节次，可能是学期尚未排课，或页面结构已变化',
    );
  }

  return {
    termId,
    termName,
    weekDates,
    periodNumbers: [...periodSet].sort((a, b) => a - b),
    slots,
  };
}

/** 组装成对外的课表对象。 */
export function buildTimetable(baseUrl: string, html: string, fetchedAt: string): SchoolTimetable {
  const parsed = parseTimetableHtml(html);
  return {
    baseUrl,
    termId: parsed.termId,
    termName: parsed.termName,
    weekDates: parsed.weekDates,
    periodNumbers: parsed.periodNumbers,
    slots: parsed.slots,
    fetchedAt,
    rawHtml: html,
  };
}

/** 稳定且可读的外部键，用于幂等映射（同一学程同一天同一节只应有一条日程）。 */
export function slotExternalKey(termId: string | null, slot: SchoolSlot): string {
  return `${termId ?? 'unknown'}:${slot.weekday}:${slot.period}`;
}
