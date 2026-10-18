/** 颜色工具：把分类色安全地用在文本、色块与边框上。 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function hexToRgb(hex: string): Rgb {
  const match = HEX_PATTERN.exec(hex.trim());
  if (!match) return { r: 15, g: 118, b: 110 };

  let value = match[1] ?? '0f766e';
  if (value.length === 3) {
    value = value
      .split('')
      .map((char) => `${char}${char}`)
      .join('');
  }
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  const clamped = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${clamped})`;
}

/** WCAG 相对亮度。 */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

const DARK_INK = '#101418';
const LIGHT_INK = '#ffffff';

/**
 * 在给定底色上挑选对比度更高的文字色。
 * 事件色块直接用分类色填充，因此必须动态决定文字用深墨还是白字，
 * 保证任何用户自选颜色下都能达到 WCAG AA。
 */
export function readableInk(background: string): string {
  return contrastRatio(LIGHT_INK, background) >= contrastRatio(DARK_INK, background)
    ? LIGHT_INK
    : DARK_INK;
}

/** 把分类色压暗，用于浅底 + 同色文字的弱强调场景。 */
export function darken(hex: string, amount = 0.24): string {
  const { r, g, b } = hexToRgb(hex);
  const mix = (value: number): number => Math.round(value * (1 - amount));
  return `#${[mix(r), mix(g), mix(b)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** 生成用于事件块的配色组合（底色、文字色、边框色）。 */
export function eventPalette(color: string, dark: boolean): {
  background: string;
  text: string;
  border: string;
} {
  const alpha = dark ? 0.26 : 0.14;
  return {
    background: withAlpha(color, alpha),
    text: dark ? lightenForDark(color) : darken(color, 0.34),
    border: withAlpha(color, dark ? 0.5 : 0.34),
  };
}

function lightenForDark(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const mix = (value: number): number => Math.round(value + (255 - value) * 0.32);
  return `#${[mix(r), mix(g), mix(b)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}
