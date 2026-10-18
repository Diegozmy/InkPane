import { describe, expect, it } from 'vitest';
import { SchoolPortalError } from '../src/modules/courses/client.js';
import {
  buildTimetable,
  decodeEntities,
  parsePeriodNumber,
  parseTimetableHtml,
  parseWeekday,
  slotExternalKey,
  stripTags,
} from '../src/modules/courses/parser.js';

/** 与真实站点结构一致的课表片段（已按 2026-10-16 抓取到的响应 1:1 还原）。 */
const REAL_SHAPE = `<div class="kb">
<select name="xuecheng" id="xuecheng" disabled="disabled"><option value="101" >2025-2026学年第五学程</option><option value="102" selected>2026-2027学年第一学程</option></select>
<table width="100%" border="0" cellspacing="0" cellpadding="0">
  <tr><td style="text-align:center;"></td><td style="text-align:center;">星期日(2026-10-11)</td><td style="text-align:center;">星期一(2026-10-12)</td><td style="text-align:center;">星期二(2026-10-13)</td><td style="text-align:center;">星期三(2026-10-14)</td><td style="text-align:center;">星期四(2026-10-15)</td><td style="text-align:center;">星期五(2026-10-16)</td><td style="text-align:center;">星期六(2026-10-17)</td></tr>
  <tr class="odd"><td style="text-align:center;">第一节</td><td class="spec_td"></td><td class="spec_td"><span><div>高三语文1-1</div><div>朱英杰</div><div>301</div></span></td><td class="spec_td"><span><div>高三物理1-2</div><div>周勇</div><div>306</div></span></td><td class="spec_td"><span><div>高三英语1-1</div><div>童阳</div><div>301</div></span></td><td class="spec_td"><span><div>高三化学1-4</div><div>潘煌</div><div>309</div></span></td><td class="spec_td"><span><div>高三数学1-1</div><div>蔡晙晔</div><div>301</div></span></td><td class="spec_td"></td></tr>
  <tr class=""><td style="text-align:center;">第二节</td><td class="spec_td"></td><td class="spec_td"><span><div>高三英语1-1</div><div>童阳</div><div>301</div></span></td><td class="spec_td"><span><div>高三体育1-1</div><div>张宇浩</div><div>体育馆</div></span></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td></tr>
  <tr class="odd"><td style="text-align:center;">第八节</td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"><span><div>高三啦啦操-1</div><div>晁宁雪</div><div>体育馆</div></span></td><td class="spec_td"></td><td class="spec_td"></td></tr>
  <tr class=""><td style="text-align:center;">第九节</td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td></tr>
</table></div>`;

describe('基础文本处理', () => {
  it('解码常见 HTML 实体', () => {
    expect(decodeEntities('a&nbsp;b&amp;c&lt;d&gt;e&quot;f&#39;g')).toBe('a b&c<d>e"f\'g');
  });

  it('去标签并压缩空白', () => {
    expect(stripTags('<div>  高三  语文 </div>')).toBe('高三 语文');
  });
});

describe('节次与星期解析', () => {
  it('支持中文数字节次', () => {
    expect(parsePeriodNumber('第一节')).toBe(1);
    expect(parsePeriodNumber('第九节')).toBe(9);
    expect(parsePeriodNumber('第十节')).toBe(10);
    expect(parsePeriodNumber('第十一节')).toBe(11);
    expect(parsePeriodNumber('第十二节')).toBe(12);
    expect(parsePeriodNumber('第二十节')).toBe(20);
  });

  it('支持阿拉伯数字节次', () => {
    expect(parsePeriodNumber('第3节')).toBe(3);
    expect(parsePeriodNumber('第 10 节')).toBe(10);
    expect(parsePeriodNumber('5')).toBe(5);
  });

  it('识别不了的内容返回 null 而不是猜', () => {
    expect(parsePeriodNumber('上午')).toBeNull();
    expect(parsePeriodNumber('')).toBeNull();
    expect(parsePeriodNumber('第99节')).toBeNull();
  });

  it('星期解析统一成 周一=1 … 周日=7', () => {
    expect(parseWeekday('星期一(2026-10-12)')).toBe(1);
    expect(parseWeekday('周三')).toBe(3);
    expect(parseWeekday('星期六')).toBe(6);
    expect(parseWeekday('星期日')).toBe(7);
    expect(parseWeekday('星期天')).toBe(7);
    expect(parseWeekday('节次')).toBeNull();
  });
});

describe('课表解析（真实结构）', () => {
  const result = parseTimetableHtml(REAL_SHAPE);

  it('取出当前选中的学程', () => {
    expect(result.termId).toBe('102');
    expect(result.termName).toBe('2026-2027学年第一学程');
  });

  it('从表头取出当周各天日期', () => {
    expect(result.weekDates).toHaveLength(7);
    const monday = result.weekDates.find((item) => item.weekday === 1);
    expect(monday?.dateKey).toBe('2026-10-12');
  });

  it('只收集真正有课的行与单元格', () => {
    // 第一节 5 门 + 第二节 2 门 + 第八节 1 门 = 8；第九节整行为空但仍算作一个节次
    expect(result.slots).toHaveLength(8);
    expect(result.periodNumbers).toEqual([1, 2, 8, 9]);
  });

  it('按星期与节次正确定位', () => {
    const target = result.slots.find((slot) => slot.weekday === 1 && slot.period === 1);
    expect(target).toMatchObject({ courseName: '高三语文1-1', teacher: '朱英杰', room: '301' });
  });

  it('列顺序按 星期日 起算也能正确映射到星期', () => {
    // 星期日是第一数据列，且该列全空；若有内容应落在 weekday=7
    const sunday = result.slots.filter((slot) => slot.weekday === 7);
    expect(sunday).toHaveLength(0);
  });

  it('生成稳定且唯一的外部键', () => {
    const keys = result.slots.map((slot) => slotExternalKey(result.termId, slot));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('102:1:1');
    // 第八节唯一的课在「星期四」列（列 5），对应 weekday=4
    expect(keys).toContain('102:4:8');
  });
});

describe('课表解析（边界情况）', () => {
  it('表头没有日期时仍能解析，只是 weekDates 为空', () => {
    const html = `<table>
      <tr><td></td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td><td>星期六</td><td>星期日</td></tr>
      <tr><td>第一节</td><td class="spec_td"><div>数学</div><div>王老师</div><div>201</div></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td><td class="spec_td"></td></tr>
    </table>`;
    const result = parseTimetableHtml(html);
    expect(result.weekDates).toEqual([]);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]?.weekday).toBe(1);
  });

  it('完全没有表头时按「第 1 列 = 周一」兜底', () => {
    const html = `<table>
      <tr><td>第一节</td><td><div>历史</div></td><td><div>地理</div></td><td></td><td></td><td></td><td></td><td></td></tr>
    </table>`;
    const result = parseTimetableHtml(html);
    expect(result.slots.map((slot) => slot.weekday)).toEqual([1, 2]);
  });

  it('单元格只有课程名时不编造教师与教室', () => {
    const html = `<table>
      <tr><td></td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td><td>星期六</td><td>星期日</td></tr>
      <tr><td>第一节</td><td><div>自习</div></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
    </table>`;
    const slot = parseTimetableHtml(html).slots[0];
    expect(slot).toMatchObject({ courseName: '自习', teacher: '', room: '' });
  });

  it('colspan 不会让后续列整体错位', () => {
    const html = `<table>
      <tr><td></td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td><td>星期六</td><td>星期日</td></tr>
      <tr><td>第一节</td><td colspan="2"><div>连堂课</div><div>李老师</div><div>501</div></td><td><div>英语</div></td><td></td><td></td><td></td><td></td></tr>
    </table>`;
    const result = parseTimetableHtml(html);
    // 连堂课占两列（周一、周二），英语应落在后面的「星期三」
    expect(result.slots.find((slot) => slot.courseName === '连堂课')?.weekday).toBe(1);
    expect(result.slots.find((slot) => slot.courseName === '英语')?.weekday).toBe(3);
  });

  it('整张表没有任何节次时报错，而不是静默返回空', () => {
    expect(() => parseTimetableHtml('<table><tr><td>没有课表</td></tr></table>')).toThrowError(
      SchoolPortalError,
    );
  });

  it('buildTimetable 会带上原始 HTML 供排查', () => {
    const timetable = buildTimetable('http://example.test', REAL_SHAPE, '2026-10-16T00:00:00.000Z');
    expect(timetable.rawHtml).toBe(REAL_SHAPE);
    expect(timetable.slots.length).toBeGreaterThan(0);
    expect(timetable.fetchedAt).toBe('2026-10-16T00:00:00.000Z');
  });
});
