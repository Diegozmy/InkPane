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
    expect(
      parseWakeWords('da fen qi,ni hao xiao zhi，xiao mo、hei an;li ming\nxiao yu').words,
    ).toEqual(['da fen qi', 'ni hao xiao zhi', 'xiao mo', 'hei an', 'li ming', 'xiao yu']);
  });

  it('逐项 trim、转小写、压缩空格并去重，保留首次出现的顺序', () => {
    expect(parseWakeWords(' Da  Fen Qi ，da fen qi，Ni Hao Xiao Zhi ').words).toEqual([
      'da fen qi',
      'ni hao xiao zhi',
    ]);
  });

  it('把不符合规则的项归入 invalid，不影响合法项', () => {
    const parsed = parseWakeWords('da fen qi，ni hao xiao zhi，hello，a');
    expect(parsed.words).toEqual(['da fen qi', 'ni hao xiao zhi']);
    expect(parsed.invalid).toEqual(['hello', 'a']);
  });

  it('空输入返回空结果', () => {
    expect(parseWakeWords('   ')).toEqual({ words: [], invalid: [] });
  });
});

describe('validateWakeWords', () => {
  it('通过时返回 null', () => {
    expect(validateWakeWords('da fen qi，ni hao xiao zhi')).toBeNull();
  });

  it('为空或全非法时提示至少填写 1 个', () => {
    expect(validateWakeWords('')).toBe('请至少填写 1 个唤醒词');
  });

  it('格式错误时指出第一个非法项', () => {
    expect(validateWakeWords('hello')).toBe(
      '唤醒词「hello」无效，请使用 2–12 个拼音音节，例如 da fen qi',
    );
  });

  it('超过 8 个时拒绝', () => {
    const words = [
      'da fen qi',
      'ni hao',
      'xiao mo',
      'xiao lan',
      'xiao lv',
      'xiao bai',
      'xiao hong',
      'xiao hei',
      'xiao zi',
    ];
    expect(validateWakeWords(words.join('，'))).toBe('最多支持 8 个唤醒词');
  });

  it('12 个音节可用，13 个音节不可用', () => {
    expect(validateWakeWords('a b c d e f g h i j k l')).toBeNull();
    expect(validateWakeWords('a b c d e f g h i j k l m')).toContain('无效');
  });
});

describe('formatWakeWords', () => {
  it('用中文逗号回显', () => {
    expect(formatWakeWords(['da fen qi', 'ni hao xiao zhi'])).toBe('da fen qi，ni hao xiao zhi');
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
