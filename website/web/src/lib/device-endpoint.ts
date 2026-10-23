/**
 * 设备端拉取屏幕数据的地址推导。
 *
 * 页面只负责把「设备该请求哪个地址」展示出来给人复制。优先使用构建期配置的
 * VITE_DEVICE_API_URL（例如局域网里的 http://192.168.1.20:4000），
 * 未配置时退回当前页面的 origin —— 前后端同进程部署时这两个地址是同一个。
 */

/** 设备固件里的屏幕数据路径。 */
export const DEVICE_SCREEN_PATH = '/api/device/screen';

const FALLBACK_ORIGIN = 'http://127.0.0.1:4000';

export interface DeviceEndpoint {
  /** 协议 + 主机 + 端口，已去掉尾斜杠 */
  origin: string;
  /** 仅主机名，用于回环判断与展示 */
  host: string;
  path: string;
  /** 可直接复制进固件配置的完整地址 */
  url: string;
  /** 回环地址：设备无法从局域网访问，页面需要给出警告 */
  loopback: boolean;
}

/** 去掉首尾空白与结尾斜杠；空串保持为空，交给调用方兜底。 */
export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function hostnameOf(value: string): string {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return value.trim().toLowerCase();
  }
}

/** localhost / 127.0.0.1 / [::1] 都算回环；也接受带端口的写法。 */
export function isLoopbackHost(host: string): boolean {
  const value = hostnameOf(host)
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function browserOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return '';
}

/** 当前应展示给用户的设备接口地址。 */
export function deviceEndpoint(): DeviceEndpoint {
  const configured = import.meta.env.VITE_DEVICE_API_URL;
  const candidate = configured && configured.trim() ? configured : browserOrigin();
  const origin = normalizeOrigin(candidate) || FALLBACK_ORIGIN;
  const host = hostnameOf(origin);
  return {
    origin,
    host,
    path: DEVICE_SCREEN_PATH,
    url: `${origin}${DEVICE_SCREEN_PATH}`,
    loopback: isLoopbackHost(host),
  };
}
