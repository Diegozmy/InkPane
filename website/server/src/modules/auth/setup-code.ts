/**
 * 首次初始化验证码。
 *
 * 背景：监听 0.0.0.0 / 局域网地址时，如果没有任何保护，同网段的任何人都能抢先
 * 调用 `POST /api/setup` 认领管理员账号（即「初始化接管」）。因此：
 *  - 默认在 HOST 不是回环地址时要求验证码（SETUP_REQUIRE_CODE=true）；
 *  - 启动时若仍需要初始化，生成一个 6 位数字码并只打印一次到日志；
 *  - 可用 INKPANE_SETUP_CODE 固定验证码，适合无人值守部署；
 *  - 用常量时间比较，避免通过响应时间侧信道猜码；
 *  - `/api/setup` 成功后码立即失效（系统已完成初始化时本来也会 409）。
 *
 * 注意：这是「防误操作/防抢注」的轻量措施，不是强认证；码会出现在启动日志里，
 * 生产环境应通过 HTTPS 反代访问并限制日志可见范围。
 */

import { randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import type { SqliteDatabase } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { setupRequired } from './service.js';

const CODE_LENGTH = 6;
const MAX_CODE_LENGTH = 64;

let generatedCode: string | null = null;
let announced = false;
let consumed = false;

/** 当前部署是否要求初始化验证码。 */
export function setupCodeRequired(): boolean {
  return config.setupRequireCode;
}

function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, '0');
}

/** 当前生效的验证码；不要求或已失效时返回 null。 */
export function currentSetupCode(): string | null {
  if (!config.setupRequireCode || consumed) return null;
  if (config.setupCode !== '') return config.setupCode;
  generatedCode ??= generateCode();
  return generatedCode;
}

/**
 * 启动接线：仅当「仍需要初始化」且「要求验证码」时生成并打印一次。
 * 由 index.ts 在数据库迁移与管理员引导之后调用。
 */
export function initializeSetupCode(db: SqliteDatabase): void {
  if (announced) return;
  if (!config.setupRequireCode) return;
  if (!setupRequired(db)) return;
  announced = true;
  const code = currentSetupCode();
  if (code === null) return;
  logger.warn('首次初始化需要验证码，请打开控制台并输入以下 6 位码（只打印一次，重启后重新生成）', {
    setupCode: code,
  });
}

/** 常量时间比较验证码；未要求验证码时一律通过。 */
export function verifySetupCode(input: unknown): boolean {
  if (!config.setupRequireCode) return true;
  if (consumed) return false;
  if (typeof input !== 'string') return false;
  const normalized = input.trim();
  if (normalized.length === 0 || normalized.length > MAX_CODE_LENGTH) return false;
  const expected = currentSetupCode();
  if (expected === null) return false;

  const actualBuffer = Buffer.from(normalized, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

/** `/api/setup` 成功后调用：验证码立即失效。 */
export function invalidateSetupCode(): void {
  consumed = true;
  generatedCode = null;
  announced = true;
}

/** 测试用：重置进程内状态（每个测试用例使用新的内存数据库后需要重新验证）。 */
export function __resetSetupCodeForTests(): void {
  generatedCode = null;
  announced = false;
  consumed = false;
}
