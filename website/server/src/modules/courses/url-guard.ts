/**
 * 课程同步地址的 SSRF 防护。
 *
 * 学校系统地址由用户配置，服务端会主动去访问它。如果不加限制，
 * 这个「可配置 URL + 服务端发起请求」的组合就是一个标准的 SSRF 跳板：
 * 攻击者可以借此访问回环、私网、云厂商元数据等地址。
 *
 * 防护分两层：
 *  1. 同步的字面量检查：协议只允许 http/https、禁止 userinfo、禁止私网/回环/链路本地/ULA 字面量；
 *  2. 异步的 DNS 解析检查：域名可能解析到私网（也防 DNS 重绑定的一部分），
 *     `dns.lookup(host, { all: true })` 返回的任一地址是私网就拒绝。
 *
 * 校园网/本地测试场景可通过 `COURSE_ALLOW_PRIVATE_HOSTS=true` 显式放开；
 * 测试环境（NODE_ENV=test）同样短路，避免用例访问不了本地测试服务器。
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../../config.js';
import { ValidationError } from '../../http/errors.js';

export interface CourseUrlLookupAddress {
  address: string;
  family?: number;
}

export type CourseUrlLookup = (
  hostname: string,
) => Promise<ReadonlyArray<CourseUrlLookupAddress>>;

export interface CourseUrlGuardOptions {
  /** 覆盖默认旁路（config.courseAllowPrivateHosts || config.isTest），便于测试真实校验逻辑。 */
  allowPrivateHosts?: boolean;
  /** 覆盖 DNS 解析函数，便于测试不同解析结果。 */
  lookup?: CourseUrlLookup;
}

const PRIVATE_TARGET_MESSAGE =
  '学校系统地址指向本机、私网或保留地址，已拒绝；如确需使用请设置 COURSE_ALLOW_PRIVATE_HOSTS=true';
const DNS_FAILED_MESSAGE = '学校系统地址无法解析，请检查域名是否正确';

function stripHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zoneIndex = value.indexOf('%');
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (value.endsWith('.')) value = value.slice(0, -1);
  return value;
}

function ipv4Parts(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    numbers.push(value);
  }
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 0];
}

/** IPv4 私网/回环/链路本地/保留/广播地址。 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ipv4Parts(ip);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 运营商级 NAT（100.64.0.0/10）与基准测试网段（198.18.0.0/15）
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 组播（224+）与保留/广播地址同样不应作为课程源
  if (a >= 224) return true;
  return false;
}

function ipv4FromMappedIpv6(ip: string): string | null {
  if (!ip.startsWith('::ffff:')) return null;
  const rest = ip.slice('::ffff:'.length);
  if (rest.includes('.')) return rest;
  const parts = rest.split(':');
  if (parts.length !== 2) return null;
  const hi = Number.parseInt(parts[0] ?? '', 16);
  const lo = Number.parseInt(parts[1] ?? '', 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** IPv6 回环/未指定/ULA/链路本地/组播/IPv4 映射地址。 */
export function isPrivateIpv6(ip: string): boolean {
  const normalized = stripHost(ip);
  if (normalized === '::' || normalized === '::1') return true;

  const mapped = ipv4FromMappedIpv6(normalized);
  if (mapped !== null) return isPrivateIpv4(mapped);

  // fc00::/7（ULA）
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  // fe80::/10（链路本地）
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  // ff00::/8（组播）
  if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;
  return false;
}

/** 单个 IP 地址是否属于不可外连的保留网段。 */
export function isPrivateAddress(address: string): boolean {
  const host = stripHost(address);
  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version === 6) return isPrivateIpv6(host);
  return isPrivateHostLiteral(host);
}

/** 主机名字面量是否指向本机/私网（不做 DNS）。 */
export function isPrivateHostLiteral(hostname: string): boolean {
  const host = stripHost(hostname);
  if (host.length === 0) return true;

  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version === 6) return isPrivateIpv6(host);

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // mDNS / 局域网主机名常见后缀
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  return false;
}

function allowPrivateTargets(options: CourseUrlGuardOptions): boolean {
  return options.allowPrivateHosts ?? (config.courseAllowPrivateHosts || config.isTest);
}

/** 解析并做与目标无关的基础校验（协议、userinfo）。 */
export function parseCourseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError('学校系统地址不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('学校系统地址必须使用 http 或 https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ValidationError('学校系统地址不能包含用户名或密码');
  }
  return url;
}

/**
 * 同步校验：协议、userinfo 与字面量私网地址。
 * 返回解析后的 URL，便于调用方复用。
 */
export function assertCourseUrlLiteralAllowed(
  raw: string,
  options: CourseUrlGuardOptions = {},
): URL {
  const url = parseCourseUrl(raw);
  if (allowPrivateTargets(options)) return url;
  if (isPrivateHostLiteral(url.hostname)) {
    throw new ValidationError(PRIVATE_TARGET_MESSAGE);
  }
  return url;
}

const defaultLookup: CourseUrlLookup = async (hostname) => lookup(hostname, { all: true });

/**
 * 异步校验：字面量 + DNS 解析结果。
 * 域名解析到任意私网地址即拒绝；解析失败也拒绝（避免静默落到别的解析路径）。
 */
export async function assertCourseUrlResolvable(
  raw: string,
  options: CourseUrlGuardOptions = {},
): Promise<URL> {
  const url = assertCourseUrlLiteralAllowed(raw, options);
  if (allowPrivateTargets(options)) return url;

  const host = stripHost(url.hostname);
  // 公网 IP 字面量无需再查 DNS（私网字面量已在上一步拒绝）
  if (isIP(host) !== 0) return url;

  const lookupFn = options.lookup ?? defaultLookup;
  let addresses: ReadonlyArray<CourseUrlLookupAddress>;
  try {
    addresses = await lookupFn(host);
  } catch {
    throw new ValidationError(DNS_FAILED_MESSAGE);
  }
  if (addresses.length === 0) throw new ValidationError(DNS_FAILED_MESSAGE);

  for (const item of addresses) {
    if (isPrivateAddress(item.address)) {
      throw new ValidationError(PRIVATE_TARGET_MESSAGE);
    }
  }
  return url;
}
