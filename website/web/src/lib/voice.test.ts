import { describe, expect, it } from 'vitest';
import {
  formatWakeWords,
  isValidOtaUrl,
  parseIntInRange,
  parseWakeWords,
  validateWakeWords,
} from './voice';

describe('parseWakeWords', () => {
  it('支持中英文逗号、顿号、分号与换行分隔', () => {
    expect(parseWakeWords('你好小智,小墨，阿丽斯、小蓝;小绿\n小白').words).toEqual([
      '你好小智',
      '小墨',
      '阿丽斯',
      '小蓝',
      '小绿',
      '小白',
    ]);
  });

  it('逐项 trim 并去重，保留首次出现的顺序', () => {
    expect(parseWakeWords(' 你好小智 ，小墨，你好小智 ').words).toEqual(['你好小智', '小墨']);
  });

  it('把不符合规则的项归入 invalid，不影响合法项', () => {
    const parsed = parseWakeWords('你好，小墨，hello，你');
    expect(parsed.words).toEqual(['你好', '小墨']);
    expect(parsed.invalid).toEqual(['hello', '你']);
  });

  it('空输入返回空结果', () => {
    expect(parseWakeWords('   ')).toEqual({ words: [], invalid: [] });
  });
});

describe('validateWakeWords', () => {
  it('通过时返回 null', () => {
    expect(validateWakeWords('你好小智，小墨')).toBeNull();
  });

  it('为空或全非法时提示至少填写 1 个', () => {
    expect(validateWakeWords('')).toBe('请至少填写 1 个唤醒词');
  });

  it('格式错误时指出第一个非法项', () => {
    expect(validateWakeWords('hello')).toBe('唤醒词「hello」无效，请使用 2–12 个汉字');
  });

  it('超过 8 个时拒绝', () => {
    const words = ['你好小智', '小墨', '阿丽斯', '小蓝', '小绿', '小白', '小红', '小黑', '小紫'];
    expect(validateWakeWords(words.join('，'))).toBe('最多支持 8 个唤醒词');
  });

  it('12 个汉字可用，13 个汉字不可用', () => {
    expect(validateWakeWords('一二三四五六七八九十一二')).toBeNull();
    expect(validateWakeWords('一二三四五六七八九十一二三')).toContain('无效');
  });
});

describe('formatWakeWords', () => {
  it('用中文逗号回显', () => {
    expect(formatWakeWords(['你好小智', '小墨'])).toBe('你好小智，小墨');
    expect(formatWakeWords([])).toBe('');
  });
});

describe('isValidOtaUrl', () => {
  it('接受 http(s) 地址', () => {
    expect(isValidOtaUrl('https://api.tenclass.net/xiaozhi/ota/')).toBe(true);
    expect(isValidOtaUrl(' http://192.168.1.20:8003/xiaozhi/ota/ ')).toBe(true);
  });

  it('拒绝其它协议、非 URL 与超长地址', () => {
    expect(isValidOtaUrl('ftp://example.com/ota')).toBe(false);
    expect(isValidOtaUrl('not-a-url')).toBe(false);
    expect(isValidOtaUrl('')).toBe(false);
    expect(isValidOtaUrl(`https://example.com/${'x'.repeat(200)}`)).toBe(false);
  });
});

describe('parseIntInRange', () => {
  it('接受范围内的整数', () => {
    expect(parseIntInRange('0', 0, 100)).toBe(0);
    expect(parseIntInRange('65', 0, 100)).toBe(65);
    expect(parseIntInRange('100', 0, 100)).toBe(100);
  });

  it('拒绝空串、小数、负数与越界值', () => {
    expect(parseIntInRange('', 0, 100)).toBeNull();
    expect(parseIntInRange('65.5', 0, 100)).toBeNull();
    expect(parseIntInRange('-1', 0, 100)).toBeNull();
    expect(parseIntInRange('101', 0, 100)).toBeNull();
    expect(parseIntInRange('abc', 0, 100)).toBeNull();
  });
});
