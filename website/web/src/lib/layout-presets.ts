/**
 * 800 × 480 屏幕的窗格布局预设。
 *
 * 预设只是「一份完整的 6 模块矩形表」：应用预设后仍然可以单独开关模块，
 * 保存时按 MODULE_ORDER 输出，因此服务端拿到的永远是结构完整的布局。
 */

import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from '@/types';
import type { DisplayLayout, DisplayModule, DisplayModuleId } from '@/types';

export type PresetKey = 'balanced' | 'schedule' | 'weather' | 'minimal';

export interface LayoutPreset {
  key: PresetKey;
  name: string;
  description: string;
  modules: Record<DisplayModuleId, DisplayModule>;
}

/** 模块的展示 / 输出顺序，与服务端 seeds 保持一致。 */
export const MODULE_ORDER: readonly DisplayModuleId[] = [
  'clock',
  'calendar',
  'weather',
  'schedule',
  'courses',
  'todos',
];

function module(
  id: DisplayModuleId,
  x: number,
  y: number,
  w: number,
  h: number,
  enabled = true,
): DisplayModule {
  return { id, x, y, w, h, enabled };
}

export const PRESETS: readonly LayoutPreset[] = [
  {
    key: 'balanced',
    name: '均衡',
    description: '左栏时钟 / 月历 / 待办，中间天气 / 课程，右栏整列日程。',
    modules: {
      clock: module('clock', 16, 16, 220, 100),
      calendar: module('calendar', 16, 128, 220, 180),
      todos: module('todos', 16, 320, 220, 144),
      weather: module('weather', 248, 16, 240, 288),
      courses: module('courses', 248, 316, 240, 148),
      schedule: module('schedule', 500, 16, 284, 448),
    },
  },
  {
    key: 'schedule',
    name: '日程优先',
    description: '日程独占中栏，时钟、月历、待办靠左，天气与课程收进右栏。',
    modules: {
      clock: module('clock', 16, 16, 200, 92),
      calendar: module('calendar', 16, 120, 200, 176),
      todos: module('todos', 16, 308, 200, 156),
      schedule: module('schedule', 228, 16, 360, 448),
      weather: module('weather', 600, 16, 184, 240),
      courses: module('courses', 600, 268, 184, 196),
    },
  },
  {
    key: 'weather',
    name: '天气优先',
    description: '左边一整块天气，右上月历与课程，日程仍占右栏。',
    modules: {
      clock: module('clock', 16, 16, 232, 100),
      weather: module('weather', 16, 128, 232, 336),
      calendar: module('calendar', 260, 16, 244, 200),
      courses: module('courses', 260, 228, 244, 120),
      todos: module('todos', 260, 360, 244, 104),
      schedule: module('schedule', 516, 16, 268, 448),
    },
  },
  {
    key: 'minimal',
    name: '极简',
    description: '只保留时钟、天气与日程，其余窗格关闭。适合「一窗墨色」的克制桌面。',
    modules: {
      clock: module('clock', 16, 16, 368, 160),
      weather: module('weather', 396, 16, 388, 220),
      schedule: module('schedule', 16, 188, 768, 276),
      calendar: module('calendar', 16, 16, 220, 180, false),
      courses: module('courses', 248, 316, 240, 148, false),
      todos: module('todos', 16, 320, 220, 144, false),
    },
  },
];

export function presetByKey(key: string): LayoutPreset | null {
  return PRESETS.find((preset) => preset.key === key) ?? null;
}

/** 兜底布局：第一套（均衡）预设的模块。 */
function defaultModules(): DisplayModule[] {
  const primary = PRESETS[0];
  return primary ? Object.values(primary.modules) : [];
}

/** 把任意模块数组规整成 MODULE_ORDER 顺序的完整布局；缺失模块用预设值兜底。 */
export function normalizeModules(
  modules: readonly DisplayModule[],
  fallback: readonly DisplayModule[] = defaultModules(),
): DisplayModule[] {
  return MODULE_ORDER.map((id) => {
    const found = modules.find((item) => item.id === id);
    if (found) return { ...found };
    const source = fallback.find((item) => item.id === id);
    return source
      ? { ...source }
      : { id, x: 16, y: 16, w: 220, h: 100, enabled: false };
  });
}

/** 一份布局的稳定签名，用来判断当前草稿命中了哪个预设。 */
export function layoutSignature(modules: readonly DisplayModule[]): string {
  return MODULE_ORDER.map((id) => {
    const found = modules.find((item) => item.id === id);
    if (!found) return id;
    return `${id}:${found.enabled ? 1 : 0}:${found.x},${found.y},${found.w},${found.h}`;
  }).join('|');
}

/** 命中某个预设时返回它，否则返回 null（说明用户手工改过）。 */
export function presetOf(layout: DisplayLayout | null | undefined): LayoutPreset | null {
  if (!layout) return null;
  const current = layoutSignature(layout.modules);
  return PRESETS.find((preset) => layoutSignature(Object.values(preset.modules)) === current) ?? null;
}

/** 预设的模块按 MODULE_ORDER 展开，供「应用预设」直接写进草稿。 */
export function presetModules(preset: LayoutPreset): DisplayModule[] {
  return MODULE_ORDER.map((id) => ({ ...preset.modules[id] }));
}

/** 布局草稿是否落在 800 × 480 画布内（用于诊断提示）。 */
export function modulesInsideCanvas(modules: readonly DisplayModule[]): boolean {
  return modules.every(
    (item) =>
      item.x >= 0 &&
      item.y >= 0 &&
      item.x + item.w <= DISPLAY_WIDTH &&
      item.y + item.h <= DISPLAY_HEIGHT,
  );
}
