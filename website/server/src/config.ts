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

function resolveDatabaseFile(raw: string): string {
  if (raw === ':memory:') return raw;
  return isAbsolute(raw) ? raw : resolve(SERVER_ROOT, raw);
}

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',
  port: readPort('PORT', 4000),
  host: readString('HOST', '127.0.0.1'),
  logLevel,
  databaseFile: resolveDatabaseFile(readString('DATABASE_FILE', '../data/inkpane.sqlite')),
  corsOrigins: readString('CORS_ORIGIN', 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  bodyLimit: readString('BODY_LIMIT', '256kb'),
  serveStatic: readBoolean('SERVE_STATIC', false),
  seedOnEmpty: readBoolean('SEED_ON_EMPTY', true),
  /** 单次查询允许展开的重复日程实例上限，防止恶意/异常规则打满内存 */
  maxOccurrencesPerQuery: 1500,
} as const;

export type AppConfig = typeof config;
