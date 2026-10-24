/**
 * 监听地址说明：把「服务到底能不能被局域网设备访问」讲清楚。
 *
 * 设备端只认 IP，所以启动时直接打印同网段可填写的地址；监听回环地址时
 * 明确告警——这时设备无论填什么局域网 IP 都连不上。
 */

import { isLoopbackHost } from '../config.js';

export interface LanAddress {
  /** 网卡名（如 WLAN / 以太网 / en0） */
  name: string;
  /** 局域网 IPv4 地址 */
  address: string;
  /** 设备端可直接填写的服务地址 */
  url: string;
}

interface InterfaceLike {
  address: string;
  family: string | number;
  internal: boolean;
}

export interface ListenNotice {
  level: 'warn' | 'info';
  message: string;
  deviceUrls: string[];
}

/** 169.254/16 是 APIPA 链路本地地址，设备无法用它访问服务。 */
function isUsableIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4) return false;
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (octets[0] === 169 && octets[1] === 254) return false;
  if (octets[0] === 127) return false;
  return true;
}

function isIpv4(info: InterfaceLike): boolean {
  return info.family === 'IPv4' || info.family === 4;
}

/** 192.168/10/172.16 这类家用/办公网段排前面，Tailscale 等虚拟网卡排后面。 */
function addressRank(address: string): number {
  const octets = address.split('.').map((part) => Number.parseInt(part, 10));
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  return 3;
}

/**
 * 收集局域网内可访问的服务地址。
 * 监听回环地址时设备无论填什么局域网 IP 都连不上，因此返回空数组。
 */
export function collectLanAddresses(
  interfaces: NodeJS.Dict<InterfaceLike[] | undefined>,
  host: string,
  port: number,
): LanAddress[] {
  if (isLoopbackHost(host)) return [];
  const result: LanAddress[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (!isIpv4(info) || info.internal || !isUsableIpv4(info.address)) continue;
      result.push({ name, address: info.address, url: `http://${info.address}:${port}` });
    }
  }
  // 常见局域网地址优先：设备多半就填启动日志里的第一个地址。
  return result.sort((left, right) => addressRank(left.address) - addressRank(right.address));
}

/** 启动日志里的一句话提醒：设备端该填什么地址，或者为什么现在填了也连不上。 */
export function listenNotice(host: string, addresses: LanAddress[]): ListenNotice {
  if (isLoopbackHost(host)) {
    return {
      level: 'warn',
      message:
        '当前只监听回环地址，局域网内的设备无法连接；接入设备请用 npm run dev:lan（等价于 HOST=0.0.0.0）启动',
      deviceUrls: [],
    };
  }
  if (addresses.length === 0) {
    return {
      level: 'warn',
      message: '已监听局域网，但没有找到可用的 IPv4 地址，请检查网络连接；否则设备无法填写服务地址',
      deviceUrls: [],
    };
  }
  return {
    level: 'info',
    message: `设备端可填写：${addresses.map((item) => item.url).join(' 或 ')}（需与设备处于同一局域网）`,
    deviceUrls: addresses.map((item) => item.url),
  };
}
