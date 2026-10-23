/** 设备屏幕组装所需的课程事件集合查询。 */

import type { SqliteDatabase } from '../../db/client.js';
import { all } from '../../db/query.js';

/** 课程事件 id 集合：设备屏幕据此把今天的实例拆成 events / courses 两组。 */
export function listCourseEventIds(db: SqliteDatabase, userId: number): Set<number> {
  const rows = all<{ event_id: number }>(
    db,
    'SELECT event_id FROM course_slot_links WHERE user_id = ?',
    [userId],
  );
  return new Set(rows.map((row) => Number(row.event_id)));
}
