/**
 * 本机密文盒：用于加密保存第三方系统的账号密码。
 *
 * 方案：AES-256-GCM，密钥保存在数据目录下的 .sync-key（尽力设为仅本用户可读）。
 *
 * 安全边界（必须诚实说明）：
 *  - 它能防的是「数据库文件被单独拷走」——没有密钥文件就解不开；
 *  - 它挡不住已经能以你的身份读本机文件的攻击者，因为密钥就在同机磁盘上。
 *    要做到后者需要操作系统级的密钥保管（如 Windows DPAPI / macOS Keychain），
 *    那需要原生模块，与本项目「零原生依赖」的取舍冲突，因此这里明确不承诺该强度。
 *  - 明文密码只存在于内存中的请求生命周期内，不写日志、不进数据库。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { activeDatabaseFile } from '../db/client.js';
import { logger } from './logger.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const PAYLOAD_PREFIX = 'v1';

/** 内存数据库（测试）场景下没有可持久化的数据目录，退化为进程内随机密钥。 */
let memoryKey: Buffer | null = null;

export function secretKeyPath(): string | null {
  const databaseFile = activeDatabaseFile();
  if (databaseFile === ':memory:') return null;
  return resolve(dirname(databaseFile), '.sync-key');
}

function loadOrCreateKey(): Buffer {
  const keyPath = secretKeyPath();

  if (keyPath === null) {
    if (memoryKey === null) memoryKey = randomBytes(KEY_BYTES);
    return memoryKey;
  }

  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, 'utf8').trim();
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(`密钥文件损坏（长度 ${key.length}，期望 ${KEY_BYTES}）：${keyPath}`);
    }
    return key;
  }

  const key = randomBytes(KEY_BYTES);
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  try {
    // Windows 上 chmod 作用有限，但仍能收紧支持 POSIX 权限位的环境
    chmodSync(keyPath, 0o600);
  } catch (error) {
    logger.warn('无法收紧密钥文件权限', { path: keyPath, error: String(error) });
  }
  logger.info('已生成本机加密密钥', { path: keyPath });
  return key;
}

/** 加密为 `v1:base64(iv|authTag|ciphertext)`。 */
export function encryptSecret(plaintext: string): string {
  const key = loadOrCreateKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PAYLOAD_PREFIX}:${Buffer.concat([iv, authTag, ciphertext]).toString('base64')}`;
}

/** 解密；密钥文件丢失或内容被篡改时抛错，绝不返回半成品。 */
export function decryptSecret(payload: string): string {
  const separator = payload.indexOf(':');
  if (separator < 0 || payload.slice(0, separator) !== PAYLOAD_PREFIX) {
    throw new Error('密文格式无法识别，可能来自旧版本或被改动过');
  }

  const raw = Buffer.from(payload.slice(separator + 1), 'base64');
  if (raw.length <= IV_BYTES + 16) throw new Error('密文长度不合法');

  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + 16);
  const ciphertext = raw.subarray(IV_BYTES + 16);

  const decipher = createDecipheriv(ALGORITHM, loadOrCreateKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** 脱敏展示：只保留首尾少量字符，用于界面提示「已保存的是哪个密码」。 */
export function maskSecret(plaintext: string): string {
  const length = plaintext.length;
  if (length === 0) return '';
  if (length <= 4) return '•'.repeat(length);
  return `${plaintext.slice(0, 1)}${'•'.repeat(Math.min(8, length - 2))}${plaintext.slice(-1)}`;
}

/** 测试辅助：清除进程内密钥（仅内存数据库路径使用）。 */
export function __resetMemoryKey(): void {
  memoryKey = null;
}
