import { resolve, isAbsolute } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

/**
 * 服务根目录（server/）。
 * src/config.ts 与 dist/config.js 都位于 server 下一级，因此 '..' 始终指向 server/。
 */
export const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_ROOT = resolve(SERVER_ROOT, '..');

loadEnv({ path: resolve(SERVER_ROOT, '.env') });

export type NodeEnv = 'development' | 'production' | 'test';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function readString(key: string, fallback: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function readPort(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`环境变量 ${key} 必须是 1-65535 之间的整数，当前值：${raw}`);
  }
  return value;
}

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`环境变量 ${key} 必须是布尔值（true/false），当前值：${raw}`);
}

const nodeEnv = readString('NODE_ENV', 'development') as NodeEnv;
if (!['development', 'production', 'test'].includes(nodeEnv)) {
  throw new Error(`环境变量 NODE_ENV 取值非法：${nodeEnv}`);
}

const logLevelRaw = readString('LOG_LEVEL', 'info').toLowerCase() as LogLevel;
const logLevel: LogLevel = LOG_LEVELS.includes(logLevelRaw) ? logLevelRaw : 'info';

function readPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`环境变量 ${key} 必须是正整数，当前值：${raw}`);
  }
  return value;
}

function resolveDatabaseFile(raw: string): string {
  if (raw === ':memory:') return raw;
  return isAbsolute(raw) ? raw : resolve(SERVER_ROOT, raw);
}

/**
 * 回环地址判定：仅本机可访问时，初始化验证码默认不强制。
 * 注意只认标准回环写法，`0.0.0.0` 仍视为对外监听。
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return normalized.slice(1, -1) === '::1';
  }
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

const corsOrigins = readString('CORS_ORIGIN', 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (corsOrigins.includes('*')) {
  throw new Error('CORS_ORIGIN 不能包含 *：控制台使用 Cookie 会话，必须显式列出允许的来源');
}

const bootstrapAdminUsername = readString('INKPANE_ADMIN_USERNAME', '');
const bootstrapAdminPassword = readString('INKPANE_ADMIN_PASSWORD', '');
if ((bootstrapAdminUsername === '') !== (bootstrapAdminPassword === '')) {
  throw new Error('INKPANE_ADMIN_USERNAME 与 INKPANE_ADMIN_PASSWORD 必须同时设置');
}

const host = readString('HOST', '127.0.0.1');

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: readPort('PORT', 4000),
  host,
  logLevel,
  databaseFile: resolveDatabaseFile(readString('DATABASE_FILE', '../data/inkpane.sqlite')),
  corsOrigins,
  publicOrigin: readString('PUBLIC_ORIGIN', ''),
  bodyLimit: readString('BODY_LIMIT', '256kb'),
  serveStatic: readBoolean('SERVE_STATIC', false),
  seedOnEmpty: readBoolean('SEED_ON_EMPTY', true),
  sessionTtlDays: readPositiveInt('SESSION_TTL_DAYS', 30),
  cookieSecure: readBoolean('COOKIE_SECURE', false),
  trustProxy: readBoolean('TRUST_PROXY', false),
  bootstrapAdminUsername,
  bootstrapAdminPassword,
  /**
   * 首次初始化验证码。设置后不再随机生成，便于在无人值守部署里固定下来。
   * 只有 SETUP_REQUIRE_CODE=true（默认：HOST 非回环）时才生效。
   */
  setupCode: readString('INKPANE_SETUP_CODE', ''),
  /**
   * 是否要求 /api/setup 携带验证码。默认在监听非回环地址时为 true：
   * 开放到局域网时，必须先拿到启动日志里的 6 位码才能认领管理员。
   */
  setupRequireCode: readBoolean('SETUP_REQUIRE_CODE', !isLoopbackHost(host)),
  courseAllowPrivateHosts: readBoolean('COURSE_ALLOW_PRIVATE_HOSTS', false),
  maxDevicesPerUser: 20,
  /** 单次查询允许展开的重复日程实例上限，防止恶意/异常规则打满内存 */
  maxOccurrencesPerQuery: 1500,
} as const;

export type AppConfig = typeof config;
