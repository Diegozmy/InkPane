/** 设备仓储：遥测单行表读写与课程事件集合查询。 */

import type { SqliteDatabase } from '../../db/client.js';
import { all, get, run } from '../../db/query.js';
import { nowIso } from '../../lib/clock.js';
import type { DeviceTelemetry } from '../../domain/types.js';

export interface DeviceStatusRow {
  id: number;
  last_seen_at: string | null;
  temperature: number | null;
  humidity: number | null;
  battery_voltage: number | null;
  battery_percent: number | null;
  rssi: number | null;
  firmware: string | null;
  uptime_seconds: number | null;
  updated_at: string;
}

const DEVICE_STATUS_COLUMNS = [
  'id',
  'last_seen_at',
  'temperature',
  'humidity',
  'battery_voltage',
  'battery_percent',
  'rssi',
  'firmware',
  'uptime_seconds',
  'updated_at',
].join(', ');

export function readDeviceStatus(db: SqliteDatabase): DeviceStatusRow | null {
  return (
    get<DeviceStatusRow>(db, `SELECT ${DEVICE_STATUS_COLUMNS} FROM device_status WHERE id = 1`) ?? null
  );
}

/**
 * 写入一次遥测。
 * 未上报的字段保留上一次的值（传感器可能分帧上报），但 last_seen_at / updated_at 一定刷新。
 */
export function recordDeviceTelemetry(
  db: SqliteDatabase,
  telemetry: DeviceTelemetry,
): { receivedAt: string } {
  const existing = readDeviceStatus(db);
  const receivedAt = nowIso();

  run(
    db,
    `INSERT INTO device_status
       (id, last_seen_at, temperature, humidity, battery_voltage, battery_percent, rssi,
        firmware, uptime_seconds, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       temperature = excluded.temperature,
       humidity = excluded.humidity,
       battery_voltage = excluded.battery_voltage,
       battery_percent = excluded.battery_percent,
       rssi = excluded.rssi,
       firmware = excluded.firmware,
       uptime_seconds = excluded.uptime_seconds,
       updated_at = excluded.updated_at`,
    [
      receivedAt,
      telemetry.temperature ?? existing?.temperature ?? null,
      telemetry.humidity ?? existing?.humidity ?? null,
      telemetry.batteryVoltage ?? existing?.battery_voltage ?? null,
      telemetry.batteryPercent ?? existing?.battery_percent ?? null,
      telemetry.rssi ?? existing?.rssi ?? null,
      telemetry.firmware ?? existing?.firmware ?? null,
      telemetry.uptimeSeconds ?? existing?.uptime_seconds ?? null,
      receivedAt,
    ],
  );

  return { receivedAt };
}

/** 课程事件 id 集合：设备屏幕据此把今天的实例拆成 events / courses 两组。 */
export function listCourseEventIds(db: SqliteDatabase): Set<number> {
  const rows = all<{ event_id: number }>(db, 'SELECT event_id FROM course_slot_links');
  return new Set(rows.map((row) => Number(row.event_id)));
}
