/** 设备仓储：设备行、令牌与遥测。 */

import type { SqliteDatabase } from '../../db/client.js';
import { all, get, run } from '../../db/query.js';
import { nowIso } from '../../lib/clock.js';
import type { DeviceTelemetry } from '../../domain/types.js';

export interface DeviceRow {
  id: number;
  user_id: number;
  name: string;
  token_hash: string;
  token_prefix: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string | null;
  firmware: string | null;
  battery_voltage: number | null;
  battery_percent: number | null;
  rssi: number | null;
  temperature: number | null;
  humidity: number | null;
  uptime_seconds: number | null;
  revoked_at: string | null;
}

export const DEVICE_COLUMNS = [
  'id',
  'user_id',
  'name',
  'token_hash',
  'token_prefix',
  'created_at',
  'updated_at',
  'last_seen_at',
  'firmware',
  'battery_voltage',
  'battery_percent',
  'rssi',
  'temperature',
  'humidity',
  'uptime_seconds',
  'revoked_at',
].join(', ');

export function listDeviceRows(db: SqliteDatabase, userId: number): DeviceRow[] {
  return all<DeviceRow>(
    db,
    `SELECT ${DEVICE_COLUMNS} FROM devices
     WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at ASC, id ASC`,
    [userId],
  );
}

export function findDeviceById(
  db: SqliteDatabase,
  userId: number,
  id: number,
): DeviceRow | null {
  return (
    get<DeviceRow>(
      db,
      `SELECT ${DEVICE_COLUMNS} FROM devices
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
      [id, userId],
    ) ?? null
  );
}

export function findDeviceByTokenHash(db: SqliteDatabase, tokenHash: string): DeviceRow | null {
  return (
    get<DeviceRow>(
      db,
      `SELECT ${DEVICE_COLUMNS} FROM devices
       WHERE token_hash = ? AND revoked_at IS NULL`,
      [tokenHash],
    ) ?? null
  );
}

export function countDevices(db: SqliteDatabase, userId: number): number {
  const row = get<{ count: number }>(
    db,
    'SELECT COUNT(*) AS count FROM devices WHERE user_id = ? AND revoked_at IS NULL',
    [userId],
  );
  return Number(row?.count ?? 0);
}

export function insertDevice(
  db: SqliteDatabase,
  userId: number,
  name: string,
  tokenHash: string,
  tokenPrefix: string,
): DeviceRow {
  const timestamp = nowIso();
  const result = run(
    db,
    `INSERT INTO devices (user_id, name, token_hash, token_prefix, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, name, tokenHash, tokenPrefix, timestamp, timestamp],
  );
  const created = findDeviceById(db, userId, result.lastInsertRowid);
  if (!created) throw new Error('设备写入后无法读回');
  return created;
}

export function updateDeviceName(
  db: SqliteDatabase,
  userId: number,
  id: number,
  name: string,
): DeviceRow | null {
  const changed = run(
    db,
    'UPDATE devices SET name = ?, updated_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    [name, nowIso(), id, userId],
  );
  if (changed.changes === 0) return null;
  return findDeviceById(db, userId, id);
}

export function updateDeviceToken(
  db: SqliteDatabase,
  userId: number,
  id: number,
  tokenHash: string,
  prefix: string,
): DeviceRow | null {
  const changed = run(
    db,
    `UPDATE devices SET token_hash = ?, token_prefix = ?, updated_at = ?
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [tokenHash, prefix, nowIso(), id, userId],
  );
  if (changed.changes === 0) return null;
  return findDeviceById(db, userId, id);
}

export function revokeDevice(db: SqliteDatabase, userId: number, id: number): boolean {
  const changed = run(
    db,
    `UPDATE devices SET revoked_at = ?, updated_at = ?
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [nowIso(), nowIso(), id, userId],
  );
  return changed.changes > 0;
}

/** 屏幕拉取与遥测都会刷新最近在线时间。 */
export function touchDevice(db: SqliteDatabase, deviceId: number): void {
  run(db, 'UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE id = ?', [
    nowIso(),
    nowIso(),
    deviceId,
  ]);
}

/** 写入一次遥测；未上报字段保留上一次值。 */
export function recordDeviceTelemetry(
  db: SqliteDatabase,
  deviceId: number,
  telemetry: DeviceTelemetry,
): { receivedAt: string } {
  const existing = get<DeviceRow>(db, `SELECT ${DEVICE_COLUMNS} FROM devices WHERE id = ?`, [
    deviceId,
  ]);
  const receivedAt = nowIso();
  run(
    db,
    `UPDATE devices SET
       last_seen_at = ?, updated_at = ?, temperature = ?, humidity = ?, battery_voltage = ?,
       battery_percent = ?, rssi = ?, firmware = ?, uptime_seconds = ?
     WHERE id = ?`,
    [
      receivedAt,
      receivedAt,
      telemetry.temperature ?? existing?.temperature ?? null,
      telemetry.humidity ?? existing?.humidity ?? null,
      telemetry.batteryVoltage ?? existing?.battery_voltage ?? null,
      telemetry.batteryPercent ?? existing?.battery_percent ?? null,
      telemetry.rssi ?? existing?.rssi ?? null,
      telemetry.firmware ?? existing?.firmware ?? null,
      telemetry.uptimeSeconds ?? existing?.uptime_seconds ?? null,
      deviceId,
    ],
  );
  return { receivedAt };
}
