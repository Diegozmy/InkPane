/** 设备令牌生成与哈希；完整令牌只在创建/轮换时返回一次。 */

import { createHash, randomBytes } from 'node:crypto';

export const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenPrefix(token: string): string {
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

export function generateDeviceToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const token = randomBytes(16).toString('hex');
  return { token, tokenHash: hashDeviceToken(token), tokenPrefix: tokenPrefix(token) };
}
