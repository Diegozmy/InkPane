/**
 * 语音助手设置的纯函数：唤醒词输入的解析、校验与展示。
 *
 * 规则与服务端 `voiceUpdateSchema` 保持一致，但前端先校验一次，
 * 避免把明显不合法的输入发给后端再回显 422。
 */

/** 唤醒词只支持中文：2–12 个汉字（受小智模型词表限制）。 */
export const WAKE_WORD_PATTERN = /^[\u4e00-\u9fa5]{2,12}$/;
export const WAKE_WORDS_MIN = 1;
export const WAKE_WORDS_MAX = 8;

export interface ParsedWakeWords {
  /** 合法且去重后的唤醒词 */
  words: string[];
  /** 不满足规则（格式错误）的输入 */
  invalid: string[];
}

/** 逗号 / 中文逗号 / 顿号 / 分号 / 换行分隔，逐项 trim 后去重。 */
export function parseWakeWords(input: string): ParsedWakeWords {
  const parts = input
    .split(/[,，、;；\n]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const words: string[] = [];
  const invalid: string[] = [];
  for (const part of parts) {
    if (!WAKE_WORD_PATTERN.test(part)) {
      if (!invalid.includes(part)) invalid.push(part);
      continue;
    }
    if (!words.includes(part)) words.push(part);
  }
  return { words, invalid };
}

/** 返回第一条可直接展示的校验错误；通过时返回 null。 */
export function validateWakeWords(input: string): string | null {
  const { words, invalid } = parseWakeWords(input);
  if (invalid.length > 0) {
    return `唤醒词「${invalid[0]}」无效，请使用 2–12 个汉字`;
  }
  if (words.length < WAKE_WORDS_MIN) return '请至少填写 1 个唤醒词';
  if (words.length > WAKE_WORDS_MAX) return `最多支持 ${WAKE_WORDS_MAX} 个唤醒词`;
  return null;
}

/** 回显到输入框：用中文逗号分隔，便于阅读与再次编辑。 */
export function formatWakeWords(words: readonly string[]): string {
  return words.join('，');
}

/** OTA 地址校验：必须是可解析的 http(s) URL，长度不超过 200。 */
export function isValidOtaUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 解析 0–100 的整数字符串输入；非法时返回 null（空串、负数、小数、越界均非法）。 */
export function parseIntInRange(input: string, min: number, max: number): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}
