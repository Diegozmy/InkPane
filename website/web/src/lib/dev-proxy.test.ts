import { describe, expect, it } from 'vitest';
import viteConfig from '../../vite.config';

interface ProxyOptions {
  changeOrigin?: boolean;
}

interface ServerConfig {
  proxy?: Record<string, ProxyOptions>;
}

describe('开发代理', () => {
  it('保留浏览器原始 Host，局域网写请求才能通过后端同源校验', () => {
    const server = (viteConfig as unknown as { server?: ServerConfig }).server;
    expect(server?.proxy?.['/api']?.changeOrigin).toBe(false);
  });
});
