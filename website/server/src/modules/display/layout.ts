/**
 * 屏幕布局的静态定义：默认坐标、模块目录、布局校验结果归一化。
 *
 * 坐标以 800×480 的逻辑分辨率为基准，全部落在 4 像素网格上，
 * 这样 ESP32 侧按 4 像素对齐渲染时不会出现半像素模糊。
 */

import { displayLayoutSchema } from '../../domain/schemas.js';
import {
  DISPLAY_HEIGHT,
  DISPLAY_MODULE_IDS,
  DISPLAY_WIDTH,
  type DisplayLayout,
  type DisplayModule,
  type DisplayModuleCatalogItem,
  type DisplayModuleId,
  type DisplayModuleRect,
} from '../../domain/types.js';

/** 各模块的默认位置，与契约中的默认布局完全一致。 */
const DEFAULT_RECTS: Record<DisplayModuleId, DisplayModuleRect> = {
  clock: { x: 16, y: 16, w: 220, h: 100 },
  calendar: { x: 16, y: 128, w: 220, h: 180 },
  todos: { x: 16, y: 320, w: 220, h: 144 },
  weather: { x: 248, y: 16, w: 240, h: 288 },
  courses: { x: 248, y: 316, w: 240, h: 148 },
  schedule: { x: 500, y: 16, w: 284, h: 448 },
};

/** 模块目录：前端布局编辑器据此渲染中文名、说明与「恢复默认」位置。 */
export const MODULE_CATALOG: readonly DisplayModuleCatalogItem[] = [
  {
    id: 'clock',
    name: '时钟',
    description: '大字时间、星期与日期',
    defaultRect: DEFAULT_RECTS.clock,
  },
  {
    id: 'calendar',
    name: '月历',
    description: '当月月历，并标记有日程的日期',
    defaultRect: DEFAULT_RECTS.calendar,
  },
  {
    id: 'weather',
    name: '天气',
    description: '当前天气与未来三天预报',
    defaultRect: DEFAULT_RECTS.weather,
  },
  {
    id: 'schedule',
    name: '今日日程',
    description: '今天的时间安排',
    defaultRect: DEFAULT_RECTS.schedule,
  },
  {
    id: 'courses',
    name: '今日课程',
    description: '今天要上的课程',
    defaultRect: DEFAULT_RECTS.courses,
  },
  {
    id: 'todos',
    name: '待办',
    description: '未完成的待办事项',
    defaultRect: DEFAULT_RECTS.todos,
  },
];

/** 按目录顺序生成整套默认布局。 */
export function buildDefaultLayout(updatedAt: string): DisplayLayout {
  const modules: DisplayModule[] = DISPLAY_MODULE_IDS.map((id) => ({
    id,
    enabled: true,
    ...DEFAULT_RECTS[id],
  }));
  return { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, updatedAt, modules };
}

/**
 * 把数据库里的 JSON 还原成布局；结构不合法时返回 null，由调用方回退默认布局。
 * updatedAt 缺失时使用该配置行的写入时间，避免旧数据导致设备端拿不到版本。
 */
export function parseStoredLayout(value: unknown, fallbackUpdatedAt: string): DisplayLayout | null {
  const result = displayLayoutSchema.safeParse(value);
  if (!result.success) return null;
  return {
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
    updatedAt: result.data.updatedAt ?? fallbackUpdatedAt,
    modules: result.data.modules,
  };
}
