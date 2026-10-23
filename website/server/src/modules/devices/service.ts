/** 设备服务：创建/轮换/撤销、令牌解析、遥测与状态。 */

import { getDatabase, type SqliteDatabase } from '../../db/client.js';
import { config } from '../../config.js';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../http/errors.js';
import type {
  DeviceScreenPayload,
  DeviceSummary,
  DeviceTelemetry,
} from '../../domain/types.js';
import { findUserById } from '../auth/service.js';
import { readRefreshMinutes } from '../display/settings.js';
import * as repo from './repository.js';
import {
  generateDeviceToken,
  hashDeviceToken,
  DEVICE_TOKEN_PATTERN,
} from './token.js';
import { buildDeviceScreenPayload } from '../device/screen.js';

function onlineThresholdMs(refreshMinutes: number): number {
  return Math.max(2 * refreshMinutes, 10) * 60 * 1000;
}

function toSummary(row: repo.DeviceRow, refreshMinutes: number): DeviceSummary {
  const lastSeenMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : NaN;
  const online =
    Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= onlineThresholdMs(refreshMinutes);
  return {
    id: Number(row.id),
    name: row.name,
    tokenPrefix: row.token_prefix,
    lastSeenAt: row.last_seen_at,
    online,
    firmware: row.firmware,
    batteryPercent: row.battery_percent === null ? null : Number(row.battery_percent),
    batteryVoltage: row.battery_voltage === null ? null : Number(row.battery_voltage),
    rssi: row.rssi === null ? null : Number(row.rssi),
    indoorTemperature: row.temperature === null ? null : Number(row.temperature),
    indoorHumidity: row.humidity === null ? null : Number(row.humidity),
    createdAt: row.created_at,
  };
}

export function listDevices(
  userId: number,
  db: SqliteDatabase = getDatabase(),
): DeviceSummary[] {
  const refresh = readRefreshMinutes(db, userId);
  return repo.listDeviceRows(db, userId).map((row) => toSummary(row, refresh));
}

export function getDevice(
  userId: number,
  deviceId: number,
  db: SqliteDatabase = getDatabase(),
): DeviceSummary {
  const row = repo.findDeviceById(db, userId, deviceId);
  if (!row) throw new NotFoundError('设备不存在');
  return toSummary(row, readRefreshMinutes(db, userId));
}

export interface CreatedDevice {
  device: DeviceSummary;
  token: string;
}

export function createDevice(
  userId: number,
  name: string,
  db: SqliteDatabase = getDatabase(),
): CreatedDevice {
  if (repo.countDevices(db, userId) >= config.maxDevicesPerUser) {
    throw new ConflictError(`每个账号最多绑定 ${config.maxDevicesPerUser} 台设备`);
  }
  const generated = generateDeviceToken();
  const row = repo.insertDevice(db, userId, name, generated.tokenHash, generated.tokenPrefix);
  return {
    device: toSummary(row, readRefreshMinutes(db, userId)),
    token: generated.token,
  };
}

export function renameDevice(
  userId: number,
  deviceId: number,
  name: string,
  db: SqliteDatabase = getDatabase(),
): DeviceSummary {
  const row = repo.updateDeviceName(db, userId, deviceId, name);
  if (!row) throw new NotFoundError('设备不存在');
  return toSummary(row, readRefreshMinutes(db, userId));
}

export function rotateDeviceToken(
  userId: number,
  deviceId: number,
  db: SqliteDatabase = getDatabase(),
): CreatedDevice {
  const generated = generateDeviceToken();
  const row = repo.updateDeviceToken(db, userId, deviceId, generated.tokenHash, generated.tokenPrefix);
  if (!row) throw new NotFoundError('设备不存在');
  return {
    device: toSummary(row, readRefreshMinutes(db, userId)),
    token: generated.token,
  };
}

export function removeDevice(
  userId: number,
  deviceId: number,
  db: SqliteDatabase = getDatabase(),
): void {
  if (!repo.revokeDevice(db, userId, deviceId)) throw new NotFoundError('设备不存在');
}

export interface AuthenticatedDevice {
  device: repo.DeviceRow;
  userId: number;
}

/** 设备请求鉴权：只按哈希查行，不暴露“令牌是否存在”的差异。 */
export function authenticateDevice(
  token: string | undefined,
  db: SqliteDatabase = getDatabase(),
): AuthenticatedDevice {
  const value = token?.trim().toLowerCase() ?? '';
  if (!DEVICE_TOKEN_PATTERN.test(value)) throw new UnauthorizedError('设备令牌无效');
  const row = repo.findDeviceByTokenHash(db, hashDeviceToken(value));
  if (!row) throw new UnauthorizedError('设备令牌无效');
  const user = findUserById(db, Number(row.user_id));
  if (!user || user.status !== 'active') throw new UnauthorizedError('设备令牌无效');
  return { device: row, userId: Number(row.user_id) };
}

export function recordTelemetry(
  deviceId: number,
  input: DeviceTelemetry,
  db: SqliteDatabase = getDatabase(),
): { receivedAt: string } {
  return repo.recordDeviceTelemetry(db, deviceId, input);
}

export function getScreenForDevice(
  userId: number,
  deviceId: number,
  db: SqliteDatabase = getDatabase(),
): DeviceScreenPayload {
  repo.touchDevice(db, deviceId);
  return buildDeviceScreenPayload(userId, db, new Date(), {
    id: deviceId,
    name: repo.findDeviceById(db, userId, deviceId)?.name ?? '',
  });
}
