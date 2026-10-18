/** 设备服务：屏幕数据、遥测、状态、令牌与设置。 */

import { getDatabase, type SqliteDatabase } from '../../db/client.js';
import { nowIso } from '../../lib/clock.js';
import type { DeviceSettingsInput, DeviceTelemetryInput } from '../../domain/schemas.js';
import type { DeviceScreenPayload, DeviceStatus } from '../../domain/types.js';
import { writeRefreshMinutes } from '../display/settings.js';
import * as repo from './repository.js';
import { buildDeviceScreenPayload } from './screen.js';
import {
  readDeviceName,
  readDeviceToken,
  rotateDeviceToken,
  tokenPreview,
  writeDeviceName,
} from './settings.js';

export function getDeviceScreen(db: SqliteDatabase = getDatabase()): DeviceScreenPayload {
  return buildDeviceScreenPayload(db);
}

export function recordDeviceTelemetry(
  input: DeviceTelemetryInput,
  db: SqliteDatabase = getDatabase(),
): { receivedAt: string } {
  return repo.recordDeviceTelemetry(db, input);
}

/** 控制台「设备」页的数据；screenVersion 与 /api/device/screen 的 ETag 保持一致。 */
export function getDeviceStatus(db: SqliteDatabase = getDatabase()): DeviceStatus {
  const payload = buildDeviceScreenPayload(db);
  const row = repo.readDeviceStatus(db);
  const token = readDeviceToken(db);

  return {
    paired: row !== null && row.last_seen_at !== null,
    name: readDeviceName(db),
    tokenPreview: tokenPreview(token),
    lastSeenAt: row?.last_seen_at ?? null,
    firmware: row?.firmware ?? null,
    batteryPercent: row?.battery_percent ?? null,
    batteryVoltage: row?.battery_voltage ?? null,
    rssi: row?.rssi ?? null,
    indoorTemperature: row?.temperature ?? null,
    indoorHumidity: row?.humidity ?? null,
    screenVersion: payload.etag.replace(/^"|"$/g, ''),
    refreshMinutes: payload.screen.refreshMinutes,
    layoutUpdatedAt: payload.screen.layout.updatedAt,
    serverTime: nowIso(),
  };
}

export function updateDeviceSettings(
  input: DeviceSettingsInput,
  db: SqliteDatabase = getDatabase(),
): DeviceStatus {
  if (input.name !== undefined) writeDeviceName(db, input.name);
  // 刷新间隔与显示设置共用同一个键，保证 /api/display 与设备状态一致
  if (input.refreshMinutes !== undefined) writeRefreshMinutes(db, input.refreshMinutes);
  return getDeviceStatus(db);
}

export function getDeviceToken(db: SqliteDatabase = getDatabase()): string {
  return readDeviceToken(db);
}

export function regenerateDeviceToken(db: SqliteDatabase = getDatabase()): string {
  return rotateDeviceToken(db);
}
