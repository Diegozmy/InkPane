import { describe, expect, it } from 'vitest';
import { DISPLAY_HEIGHT, DISPLAY_WIDTH } from '@/types';
import type { DisplayLayout } from '@/types';
import {
  MODULE_ORDER,
  PRESETS,
  normalizeModules,
  presetModules,
  presetOf,
} from './layout-presets';

function layoutOf(preset: (typeof PRESETS)[number]): DisplayLayout {
  return {
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
    updatedAt: '2025-06-02T00:00:00.000Z',
    modules: presetModules(preset),
  };
}

describe('布局预设', () => {
  it('提供 4 套预设，且每套都包含全部 6 个模块', () => {
    expect(PRESETS).toHaveLength(4);
    expect(PRESETS.map((preset) => preset.key)).toEqual([
      'balanced',
      'schedule',
      'weather',
      'minimal',
    ]);
    for (const preset of PRESETS) {
      expect(Object.keys(preset.modules)).toHaveLength(MODULE_ORDER.length);
      for (const id of MODULE_ORDER) {
        expect(preset.modules[id].id).toBe(id);
      }
    }
  });

  it('每个模块都完整落在 800 × 480 画布内', () => {
    for (const preset of PRESETS) {
      for (const id of MODULE_ORDER) {
        const rect = preset.modules[id];
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w).toBeLessThanOrEqual(DISPLAY_WIDTH);
        expect(rect.y + rect.h).toBeLessThanOrEqual(DISPLAY_HEIGHT);
        expect(rect.w).toBeGreaterThan(0);
        expect(rect.h).toBeGreaterThan(0);
      }
    }
  });

  it('坐标与宽高都是 4 的倍数，符合墨水屏对齐约束', () => {
    for (const preset of PRESETS) {
      for (const id of MODULE_ORDER) {
        const rect = preset.modules[id];
        for (const value of [rect.x, rect.y, rect.w, rect.h]) {
          expect(value % 4).toBe(0);
        }
      }
    }
  });

  it('presetOf 能命中每一套预设', () => {
    for (const preset of PRESETS) {
      expect(presetOf(layoutOf(preset))?.key).toBe(preset.key);
    }
  });

  it('presetOf 在手工改动坐标后不命中任何预设', () => {
    const first = PRESETS[0];
    expect(first).toBeTruthy();
    if (!first) return;
    const layout = layoutOf(first);
    const clock = layout.modules.find((module) => module.id === 'clock');
    expect(clock).toBeTruthy();
    if (!clock) return;
    layout.modules = layout.modules.map((module) =>
      module.id === 'clock' ? { ...module, x: module.x + 4 } : module,
    );
    expect(presetOf(layout)).toBeNull();
  });

  it('presetOf 对空布局返回 null', () => {
    expect(presetOf(null)).toBeNull();
    expect(presetOf(undefined)).toBeNull();
  });

  it('normalizeModules 补齐缺失模块并按 MODULE_ORDER 输出', () => {
    const first = PRESETS[0];
    expect(first).toBeTruthy();
    if (!first) return;
    const normalized = normalizeModules([presetModules(first)[0]!]);
    expect(normalized.map((module) => module.id)).toEqual([...MODULE_ORDER]);
    expect(normalized).toHaveLength(MODULE_ORDER.length);
  });
});
