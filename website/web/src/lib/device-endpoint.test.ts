import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_SCREEN_PATH,
  deviceEndpoint,
  isLoopbackHost,
  normalizeOrigin,
} from './device-endpoint';

function stubWindowOrigin(origin: string): void {
  vi.stubGlobal('window', { location: { origin } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('normalizeOrigin', () => {
  it('去掉首尾空白与结尾斜杠', () => {
    expect(normalizeOrigin('  http://192.168.1.20:4000/  ')).toBe('http://192.168.1.20:4000');
    expect(normalizeOrigin('https://ink.example.com///')).toBe('https://ink.example.com');
  });

  it('空值保持为空，由调用方兜底', () => {
    expect(normalizeOrigin('   ')).toBe('');
  });
});

describe('isLoopbackHost', () => {
  it('识别 localhost / 127.0.0.1 / ::1', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('也接受带端口的写法', () => {
    expect(isLoopbackHost('localhost:5173')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:4000')).toBe(true);
    expect(isLoopbackHost('[::1]:4000')).toBe(true);
  });

  it('局域网 IP 与域名不算回环', () => {
    expect(isLoopbackHost('192.168.1.20')).toBe(false);
    expect(isLoopbackHost('ink.example.com')).toBe(false);
    expect(isLoopbackHost('10.0.0.5:4000')).toBe(false);
  });
});

describe('deviceEndpoint', () => {
  it('未配置环境变量时使用当前页面 origin', () => {
    stubWindowOrigin('http://192.168.1.20:4000/');
    const endpoint = deviceEndpoint();
    expect(endpoint.origin).toBe('http://192.168.1.20:4000');
    expect(endpoint.path).toBe(DEVICE_SCREEN_PATH);
    expect(endpoint.url).toBe('http://192.168.1.20:4000/api/device/screen');
    expect(endpoint.loopback).toBe(false);
  });

  it('localhost 页面会判定为回环地址', () => {
    stubWindowOrigin('http://localhost:5173');
    const endpoint = deviceEndpoint();
    expect(endpoint.loopback).toBe(true);
    expect(endpoint.host).toBe('localhost');
  });

  it('VITE_DEVICE_API_URL 优先于页面 origin', () => {
    stubWindowOrigin('http://localhost:5173');
    vi.stubEnv('VITE_DEVICE_API_URL', ' https://ink.example.com/ ');
    const endpoint = deviceEndpoint();
    expect(endpoint.origin).toBe('https://ink.example.com');
    expect(endpoint.url).toBe('https://ink.example.com/api/device/screen');
    expect(endpoint.loopback).toBe(false);
  });

  it('环境变量为空串时回退到页面 origin', () => {
    stubWindowOrigin('http://10.0.0.5:4000');
    vi.stubEnv('VITE_DEVICE_API_URL', '   ');
    expect(deviceEndpoint().origin).toBe('http://10.0.0.5:4000');
  });

  it('没有 window 时给出可用的本机兜底地址', () => {
    const endpoint = deviceEndpoint();
    expect(endpoint.origin).toBe('http://127.0.0.1:4000');
    expect(endpoint.loopback).toBe(true);
  });
});
