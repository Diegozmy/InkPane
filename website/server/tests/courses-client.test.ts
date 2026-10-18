/**
 * 学校系统客户端测试。
 *
 * 用一个本地 HTTP 服务模拟校方站点的关键行为：
 *  - 每次打开登录页都下发**不同**的 AES key/iv（真实站点就是这样，也是最容易踩的坑）
 *  - 只接受 AES-128-CBC/PKCS7 加密后的 data 字段，且内层明文不做 URL 编码
 *  - 业务接口只接受 POST，GET 一律返回「非法请求！」
 * 这样就能在不访问真实站点的前提下，把登录链路完整锁住。
 */

import { createDecipheriv, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchoolPortalClient, SchoolPortalError, extractPageSecrets } from '../src/modules/courses/client.js';

const VALID_USERNAME = 'student01';
const VALID_PASSWORD = 'p@ssword1';

const TIMETABLE_HTML = `<table>
  <tr><td></td><td>星期一(2026-10-12)</td><td>星期二(2026-10-13)</td><td>星期三(2026-10-14)</td><td>星期四(2026-10-15)</td><td>星期五(2026-10-16)</td><td>星期六(2026-10-17)</td><td>星期日(2026-10-11)</td></tr>
  <tr class="odd"><td>第一节</td><td class="spec_td"><span><div>语文</div><div>朱老师</div><div>301</div></span></td><td class="spec_td"></td><td class="spec_td"><span><div>英语</div><div>童老师</div><div>302</div></span></td><td class="spec_td"></td><td class="spec_td"><span><div>数学</div><div>蔡老师</div><div>303</div></span></td><td class="spec_td"></td><td class="spec_td"></td></tr>
</table>`;

interface CapturedRequest {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

let server: Server;
let baseUrl: string;
const captured: CapturedRequest[] = [];
const issuedKeys: string[] = [];
let currentKey = '';
let currentIv = '';

/** 16 位可打印 ASCII，且不含引号，避免破坏页面里的 `var privateKey = '…'` 写法。 */
const SECRET_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@[]{}.,;:|<>$^&*!#%+?/~-_';

function randomSecret(): string {
  return Array.from(randomBytes(16), (byte) => SECRET_ALPHABET[byte % SECRET_ALPHABET.length]).join('');
}

function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function decryptWithCurrentKey(payload: string): string {
  const decipher = createDecipheriv(
    'aes-128-cbc',
    Buffer.from(currentKey, 'utf8'),
    Buffer.from(currentIv, 'utf8'),
  );
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void readBody(request).then((body) => {
      captured.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        body,
        headers: request.headers,
      });

      const url = request.url ?? '/';

      if (url === '/') {
        // 真实站点会 302 到 /login.html
        response.statusCode = 302;
        response.setHeader('Set-Cookie', 'PHPSESSID=session-start; Path=/');
        response.setHeader('Location', '/login.html');
        response.end();
        return;
      }

      if (url === '/login.html') {
        currentKey = randomSecret();
        currentIv = randomSecret();
        issuedKeys.push(currentKey);
        response.setHeader('Set-Cookie', 'PHPSESSID=session-login; Path=/');
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(
          `<html><head><script>var privateKey = '${currentKey}';var privateIv = '${currentIv}';</script></head><body>登录</body></html>`,
        );
        return;
      }

      if (url === '/Login-checkLogin') {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (request.method !== 'POST') {
          response.end(JSON.stringify({ status: 0, info: '提交方式错误' }));
          return;
        }
        const data = new URLSearchParams(body).get('data') ?? '';
        let plain = '';
        try {
          plain = decryptWithCurrentKey(data);
        } catch {
          response.end(JSON.stringify({ status: 0, info: '解密失败' }));
          return;
        }
        // 模拟真实服务端：手工按 & 与 = 切分，不做 urldecode
        const username = /(?:^|&)username=([^&]*)/.exec(plain)?.[1] ?? '';
        const passwd = /(?:^|&)passwd=([^&]*)/.exec(plain)?.[1] ?? '';
        if (username.length === 0) {
          response.end(JSON.stringify({ status: 0, info: '请输入账号！' }));
          return;
        }
        if (username === VALID_USERNAME && passwd === VALID_PASSWORD) {
          response.end(JSON.stringify({ status: 1, info: '', url: '' }));
          return;
        }
        response.end(JSON.stringify({ status: 0, info: '帐号不存在或者密码错误', url: '' }));
        return;
      }

      if (url === '/index-index') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<html><title>数字化校园</title></html>');
        return;
      }

      if (url === '/Xskebiao') {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        // 真实站点对非 POST 一律回「非法请求！」
        if (request.method !== 'POST') {
          response.end(JSON.stringify({ haserror: true, error: '非 法 请 求!', result: [] }));
          return;
        }
        response.end(
          JSON.stringify({
            status: 1,
            url: '',
            info: {
              subtitle: '排课管理->学生课表',
              html: `<select id="xuecheng"><option value="101">旧学程</option><option value="102" selected>2026-2027学年第一学程</option></select>${TIMETABLE_HTML}`,
            },
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end('not found');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法获取测试服务端口');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('密钥解析', () => {
  it('从登录页中取出 key 与 iv', () => {
    expect(extractPageSecrets("<script>var privateKey = 'abcdefgh12345678';var privateIv = 'ABCDEFGH12345678';</script>")).toEqual({
      key: 'abcdefgh12345678',
      iv: 'ABCDEFGH12345678',
    });
  });

  it('页面结构变化时给出可诊断的错误', () => {
    expect(() => extractPageSecrets('<html>没有密钥</html>')).toThrowError(SchoolPortalError);
    expect(() => extractPageSecrets('<html>没有密钥</html>')).toThrow(/未能解析出加密密钥/);
  });
});

describe('登录与取课表', () => {
  it('能够携带正确凭据完成登录并取回课表', async () => {
    const client = new SchoolPortalClient({ baseUrl });
    await client.login({ username: VALID_USERNAME, password: VALID_PASSWORD });
    const html = await client.fetchTimetableHtml();
    expect(html).toContain('2026-2027学年第一学程');
    expect(html).toContain('语文');
  });

  it('内层明文不做 URL 编码（原样发送），与服务端手工切分保持一致', async () => {
    const client = new SchoolPortalClient({ baseUrl });
    await client.login({ username: VALID_USERNAME, password: VALID_PASSWORD });

    const loginRequest = [...captured].reverse().find((item) => item.url === '/Login-checkLogin');
    expect(loginRequest).toBeDefined();
    const data = new URLSearchParams(loginRequest?.body ?? '').get('data') ?? '';
    const plain = decryptWithCurrentKey(data);
    expect(plain).toBe(`username=${VALID_USERNAME}&passwd=${VALID_PASSWORD}`);
  });

  it('每次登录都会重新取一次随机密钥（不能复用）', async () => {
    const before = issuedKeys.length;
    const client = new SchoolPortalClient({ baseUrl });
    await client.login({ username: VALID_USERNAME, password: VALID_PASSWORD });
    expect(issuedKeys.length).toBe(before + 1);
    expect(new Set(issuedKeys).size).toBe(issuedKeys.length);
  });

  it('课表接口使用 POST（GET 会被站点拒绝）', async () => {
    const client = new SchoolPortalClient({ baseUrl });
    await client.login({ username: VALID_USERNAME, password: VALID_PASSWORD });
    await client.fetchTimetableHtml();
    const timetableRequest = [...captured].reverse().find((item) => item.url === '/Xskebiao');
    expect(timetableRequest?.method).toBe('POST');
    expect(timetableRequest?.headers['x-requested-with']).toBe('XMLHttpRequest');
  });

  it('重定向过程中的 Cookie 会被保留', async () => {
    const client = new SchoolPortalClient({ baseUrl });
    await client.login({ username: VALID_USERNAME, password: VALID_PASSWORD });
    await client.fetchTimetableHtml();
    const timetableRequest = [...captured].reverse().find((item) => item.url === '/Xskebiao');
    expect(String(timetableRequest?.headers.cookie ?? '')).toContain('PHPSESSID=');
  });

  it('密码错误时抛出 auth 错误并原样带出站点提示', async () => {
    const client = new SchoolPortalClient({ baseUrl });
    await expect(client.login({ username: VALID_USERNAME, password: 'wrong-password' })).rejects.toMatchObject({
      kind: 'auth',
      message: '帐号不存在或者密码错误',
    });
  });

  it('未登录时不允许直接取课表', async () => {
    const client = new SchoolPortalClient({ baseUrl });
    await expect(client.fetchTimetableHtml()).rejects.toThrowError(/尚未登录/);
  });

  it('账号或密码为空时给出明确的凭据错误', async () => {
    const client = new SchoolPortalClient({ baseUrl });
    await expect(client.login({ username: '', password: 'x' })).rejects.toMatchObject({ kind: 'credentials' });
  });

  it('密码含 & 或 = 时提前拦截（校方接口无法处理）', async () => {
    const client = new SchoolPortalClient({ baseUrl });
    await expect(client.login({ username: 'a', password: 'p&w' })).rejects.toMatchObject({
      kind: 'credentials',
    });
  });

  it('网络不可达时抛出 network 错误而不是崩溃', async () => {
    const client = new SchoolPortalClient({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 1500 });
    await expect(client.login({ username: 'a', password: 'b' })).rejects.toMatchObject({ kind: 'network' });
  });
});
