/**
 * 设备身份设置：配对令牌与显示名称。
 *
 * 令牌是 32 位十六进制字符串（16 字节随机数），首次读取时自动生成并持久化；
 * 重新生成会直接覆盖旧值，因此旧令牌立即失效。令牌只用于设备拉取接口，
 * 管理接口（status/settings/token）保持免鉴权，符合「仅限本机」的定位。
 */

import { randomBytes } from 'node:crypto';
import type { SqliteDatabase } from '../../db/client.js';
import { readSetting, writeSetting } from '../../lib/app-settings.js';

export const DEFAULT_DEVICE_NAME = 'InkPane 墨窗';

const KEY_TOKEN = 'device.token';
const KEY_NAME = 'device.name';
const TOKEN_PATTERN = /^[0-9a-f]{32}$/;

function generateToken(): string {
  return randomBytes(16).toString('hex');
}

/** 读取令牌；缺失或格式损坏时重新生成，保证任何情况下都有可用令牌。 */
export function readDeviceToken(db: SqliteDatabase): string {
  const raw = readSetting(db, KEY_TOKEN)?.trim().toLowerCase();
  if (raw && TOKEN_PATTERN.test(raw)) return raw;
  const token = generateToken();
  writeSetting(db, KEY_TOKEN, token);
  return token;
}

/** 重新生成令牌（覆盖旧值）。 */
export function rotateDeviceToken(db: SqliteDatabase): string {
  const token = generateToken();
  writeSetting(db, KEY_TOKEN, token);
  return token;
}

export function readDeviceName(db: SqliteDatabase): string {
  const raw = readSetting(db, KEY_NAME)?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_DEVICE_NAME;
}

export function writeDeviceName(db: SqliteDatabase, name: string): string {
  writeSetting(db, KEY_NAME, name);
  return name;
}

/** 只暴露前 4 位与后 4 位，供控制台确认「是哪个设备」而不泄露完整令牌。 */
export function tokenPreview(token: string): string {
  if (token.length < 8) return token;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}
