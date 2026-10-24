/** 监听地址提示：回环告警、局域网地址收集与设备地址格式化。 */

import { describe, expect, it } from 'vitest';
import { collectLanAddresses, listenNotice } from '../src/lib/listen.js';

const interfaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  WLAN: [{ address: '192.168.71.99', family: 'IPv4', internal: false }],
  以太网: [{ address: '169.254.34.74', family: 'IPv4', internal: false }],
  'Ethernet 2': [{ address: '2001:db8::1', family: 'IPv6', internal: false }],
  eth3: [{ address: '10.0.0.8', family: 4, internal: false }],
  Tailscale: [{ address: '100.86.236.78', family: 'IPv4', internal: false }],
};

describe('collectLanAddresses', () => {
  it('监听回环地址时返回空：设备填任何局域网 IP 都连不上', () => {
    expect(collectLanAddresses(interfaces, '127.0.0.1', 4000)).toEqual([]);
    expect(collectLanAddresses(interfaces, '::1', 4000)).toEqual([]);
    expect(collectLanAddresses(interfaces, 'localhost', 4000)).toEqual([]);
  });

  it('监听 0.0.0.0 时只保留可用的局域网 IPv4，并拼出设备地址', () => {
    expect(collectLanAddresses(interfaces, '0.0.0.0', 4000)).toEqual([
      { name: 'WLAN', address: '192.168.71.99', url: 'http://192.168.71.99:4000' },
      { name: 'eth3', address: '10.0.0.8', url: 'http://10.0.0.8:4000' },
      { name: 'Tailscale', address: '100.86.236.78', url: 'http://100.86.236.78:4000' },
    ]);
  });

  it('没有可用网卡时返回空数组', () => {
    const onlyLoopback = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    };
    expect(collectLanAddresses(onlyLoopback, '0.0.0.0', 4000)).toEqual([]);
  });
});

describe('listenNotice', () => {
  it('回环监听给出 dev:lan 警告', () => {
    const notice = listenNotice('127.0.0.1', []);
    expect(notice.level).toBe('warn');
    expect(notice.message).toContain('dev:lan');
    expect(notice.message).toContain('HOST=0.0.0.0');
    expect(notice.deviceUrls).toEqual([]);
  });

  it('局域网监听时给出可填写的设备地址', () => {
    const addresses = collectLanAddresses(interfaces, '0.0.0.0', 4000);
    const notice = listenNotice('0.0.0.0', addresses);
    expect(notice.level).toBe('info');
    expect(notice.message).toContain('http://192.168.71.99:4000');
    expect(notice.deviceUrls).toEqual([
      'http://192.168.71.99:4000',
      'http://10.0.0.8:4000',
      'http://100.86.236.78:4000',
    ]);
  });

  it('监听局域网但没有任何 IPv4 时告警', () => {
    const notice = listenNotice('0.0.0.0', []);
    expect(notice.level).toBe('warn');
    expect(notice.deviceUrls).toEqual([]);
  });
});
