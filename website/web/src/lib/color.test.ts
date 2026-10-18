import { describe, expect, it } from 'vitest';
import { contrastRatio, darken, hexToRgb, readableInk, relativeLuminance, withAlpha } from './color';

describe('颜色解析', () => {
  it('解析 6 位与 3 位十六进制', () => {
    expect(hexToRgb('#0f766e')).toEqual({ r: 15, g: 118, b: 110 });
    expect(hexToRgb('0f766e')).toEqual({ r: 15, g: 118, b: 110 });
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('非法输入回退到默认色而不是抛错', () => {
    expect(hexToRgb('not-a-color')).toEqual({ r: 15, g: 118, b: 110 });
  });

  it('生成带透明度的 rgba', () => {
    expect(withAlpha('#0f766e', 0.5)).toBe('rgba(15, 118, 110, 0.5)');
  });

  it('压暗颜色会降低亮度', () => {
    expect(relativeLuminance(darken('#0f766e', 0.3))).toBeLessThan(relativeLuminance('#0f766e'));
  });
});

describe('对比度与文字色选择', () => {
  it('黑白对比度为 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('深色背景选白字，浅色背景选深墨', () => {
    expect(readableInk('#1b2a4a')).toBe('#ffffff');
    expect(readableInk('#f5f6f8')).toBe('#101418');
    expect(readableInk('#3b6fd4')).toBe('#ffffff');
  });

  it('所选文字色始终比另一种满足更高的对比度', () => {
    const samples = ['#3b6fd4', '#2f9e6e', '#c08a20', '#d1554a', '#0f766e', '#b7418a', '#f0e68c'];
    for (const color of samples) {
      const ink = readableInk(color);
      const other = ink === '#ffffff' ? '#101418' : '#ffffff';
      expect(contrastRatio(ink, color)).toBeGreaterThanOrEqual(contrastRatio(other, color));
    }
  });
});
