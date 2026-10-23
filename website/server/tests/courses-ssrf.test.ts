/**
 * 课程同步 SSRF 防护测试。
 *
 * 两条线：
 *  - url-guard 的纯函数/注入 DNS 测试（不依赖真实网络）；
 *  - SchoolPortalClient 的手动重定向：每跳都过校验、最多 3 跳。
 *
 * 注意：测试环境 NODE_ENV=test 时 guard 默认放行私网（否则访问不了本地测试服务器），
 * 因此这里通过 `allowPrivateHosts:false` / 注入 `lookup` / 注入 `validateUrl` 来验证真实逻辑。
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchoolPortalClient } from '../src/modules/courses/client.js';
import {
  assertCourseUrlLiteralAllowed,
  assertCourseUrlResolvable,
  isPrivateHostLiteral,
} from '../src/modules/courses/url-guard.js';

describe('字面量私网/保留地址', () => {
  const privateHosts = [
    'localhost',
    'console.localhost',
    '127.0.0.1',
    '127.8.9.10',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '[::1]',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'printer.local',
  ];

  it.each(privateHosts)('%s 判定为私网', (host) => {
    expect(isPrivateHostLiteral(host)).toBe(true);
  });

  const publicHosts = ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', 'example.com', 'ws8.yucai.sh.cn'];
  it.each(publicHosts)('%s 判定为公网', (host) => {
    expect(isPrivateHostLiteral(host)).toBe(false);
  });

  it('拒绝非 http(s) 协议与 userinfo', () => {
    expect(() => assertCourseUrlLiteralAllowed('file:///etc/passwd', { allowPrivateHosts: false })).toThrow(
      /http 或 https/,
    );
    expect(() => assertCourseUrlLiteralAllowed('ftp://example.com/', { allowPrivateHosts: false })).toThrow(
      /http 或 https/,
    );
    expect(() =>
      assertCourseUrlLiteralAllowed('http://user:pass@example.com/', { allowPrivateHosts: false }),
    ).toThrow(/用户名或密码/);
  });

  it('非测试模式下同步拒绝私网字面量，允许公网地址', () => {
    expect(() =>
      assertCourseUrlLiteralAllowed('http://127.0.0.1:4000/', { allowPrivateHosts: false }),
    ).toThrow(/私网|保留/);
    expect(
      assertCourseUrlLiteralAllowed('http://ws8.yucai.sh.cn/', { allowPrivateHosts: false }).hostname,
    ).toBe('ws8.yucai.sh.cn');
  });

  it('显式 allowPrivateHosts 时放行校园内网地址', () => {
    expect(
      assertCourseUrlLiteralAllowed('http://192.168.1.10/', { allowPrivateHosts: true }).hostname,
    ).toBe('192.168.1.10');
  });
});

describe('DNS 解析校验', () => {
  it('域名解析到私网地址时拒绝', async () => {
    await expect(
      assertCourseUrlResolvable('http://courses.example.edu/', {
        allowPrivateHosts: false,
        lookup: async () => [{ address: '10.1.2.3', family: 4 }],
      }),
    ).rejects.toThrow(/私网|保留/);

    await expect(
      assertCourseUrlResolvable('http://courses.example.edu/', {
        allowPrivateHosts: false,
        lookup: async () => [{ address: 'fd00::1', family: 6 }],
      }),
    ).rejects.toThrow(/私网|保留/);
  });

  it('公网解析结果放行；混合结果（含私网）拒绝', async () => {
    const resolved = await assertCourseUrlResolvable('http://courses.example.edu/', {
      allowPrivateHosts: false,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(resolved.hostname).toBe('courses.example.edu');

    await expect(
      assertCourseUrlResolvable('http://courses.example.edu/', {
        allowPrivateHosts: false,
        lookup: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '192.168.0.2', family: 4 },
        ],
      }),
    ).rejects.toThrow(/私网|保留/);
  });

  it('解析失败或结果为空时拒绝（不静默降级）', async () => {
    await expect(
      assertCourseUrlResolvable('http://courses.example.edu/', {
        allowPrivateHosts: false,
        lookup: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    ).rejects.toThrow(/无法解析/);

    await expect(
      assertCourseUrlResolvable('http://courses.example.edu/', {
        allowPrivateHosts: false,
        lookup: async () => [],
      }),
    ).rejects.toThrow(/无法解析/);
  });

  it('公网 IP 字面量不再查 DNS', async () => {
    const resolved = await assertCourseUrlResolvable('http://8.8.8.8/', {
      allowPrivateHosts: false,
      lookup: async () => {
        throw new Error('不应调用 DNS');
      },
    });
    expect(resolved.hostname).toBe('8.8.8.8');
  });
});

describe('客户端重定向校验', () => {
  let server: Server;
  let baseUrl: string;
  let mode: 'normal' | 'metadata' | 'chain' = 'normal';

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = request.url ?? '/';

      if (url === '/') {
        if (mode === 'metadata') {
          response.statusCode = 302;
          response.setHeader('Location', 'http://169.254.169.254/latest/meta-data/');
          response.end();
          return;
        }
        if (mode === 'chain') {
          response.statusCode = 302;
          response.setHeader('Location', '/r1');
          response.end();
          return;
        }
        response.statusCode = 302;
        response.setHeader('Location', '/login.html');
        response.end();
        return;
      }

      if (url === '/login.html') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
          "<html><script>var privateKey = 'abcdefgh12345678';var privateIv = 'ABCDEFGH12345678';</script></html>",
        );
        return;
      }

      const chainMatch = /^\/r(\d+)$/.exec(url);
      if (chainMatch) {
        const step = Number(chainMatch[1]);
        if (step >= 4) {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end('<html>done</html>');
          return;
        }
        response.statusCode = 302;
        response.setHeader('Location', `/r${step + 1}`);
        response.end();
        return;
      }

      response.statusCode = 404;
      response.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('无法获取测试服务端口');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('正常重定向：每一跳都执行 URL 校验', async () => {
    mode = 'normal';
    const visited: string[] = [];
    const client = new SchoolPortalClient({
      baseUrl,
      validateUrl: async (raw) => {
        visited.push(raw);
      },
    });
    const secrets = await client.loadLoginPage();
    expect(secrets.key).toBe('abcdefgh12345678');
    expect(visited).toHaveLength(2);
    expect(visited[1]).toContain('/login.html');
  });

  it('重定向到云元数据地址时被校验函数拦下，不会发起请求', async () => {
    mode = 'metadata';
    const visited: string[] = [];
    const client = new SchoolPortalClient({
      baseUrl,
      validateUrl: async (raw) => {
        visited.push(raw);
        if (raw.includes('169.254.169.254')) throw new Error('重定向目标被拒绝');
      },
    });
    await expect(client.loadLoginPage()).rejects.toThrow('重定向目标被拒绝');
    expect(visited.some((url) => url.includes('169.254.169.254'))).toBe(true);
    // 元数据地址只经过校验，不会被真正请求（服务端没有该路由，若请求会返回 404）
  });

  it('最多跟随 3 跳，超过后返回原始 3xx 并报异常状态', async () => {
    mode = 'chain';
    const visited: string[] = [];
    const client = new SchoolPortalClient({
      baseUrl,
      validateUrl: async (raw) => {
        visited.push(raw);
      },
    });
    await expect(client.loadLoginPage()).rejects.toThrow(/异常状态 302/);
    expect(visited).toHaveLength(4);
    expect(visited.some((url) => url.endsWith('/r4'))).toBe(false);
  });
});
