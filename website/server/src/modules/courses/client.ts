/**
 * 育才中学课程管理系统（ws8.yucai.sh.cn）客户端。
 *
 * 登录链路（逆向自官网前端，逐字节对齐）：
 *   1. GET 登录页，页面里会下发**本次随机**的 AES key 与 iv（每次都不同，不能缓存）
 *   2. 用 AES-CBC/PKCS7 加密 `username=<账号>&passwd=<密码>`，Base64 后作为 data 字段
 *   3. POST /Login-checkLogin，返回 {status:1} 表示成功
 *
 * 两个必须注意的坑：
 *  - 内层明文**不能做 URL 编码**。服务端只按 & 和 = 手工切分且不做 urldecode，
 *    编码后的 @ 会变成 %40 而被当成错误密码（已实测确认）。
 *  - 业务接口必须用 POST。GET 会被控制器守卫拦下并返回「非法请求!」。
 */

const DEFAULT_BASE_URL = 'http://ws8.yucai.sh.cn';
const LOGIN_PATH = '/Login-checkLogin';
const TIMETABLE_PATH = '/Xskebiao';
const REQUEST_TIMEOUT_MS = 20_000;

export class SchoolPortalError extends Error {
  readonly kind: 'network' | 'auth' | 'protocol' | 'parse' | 'credentials';
  readonly detail?: string;

  constructor(kind: SchoolPortalError['kind'], message: string, detail?: string) {
    super(message);
    this.name = 'SchoolPortalError';
    this.kind = kind;
    this.detail = detail;
  }
}

export interface SchoolCredentials {
  username: string;
  password: string;
}

export interface SchoolSlot {
  /** 1 = 周一 … 7 = 周日 */
  weekday: number;
  /** 第几节，从 1 开始 */
  period: number;
  courseName: string;
  teacher: string;
  room: string;
}

export interface SchoolTimetable {
  baseUrl: string;
  termId: string | null;
  termName: string | null;
  /** 表头给出的当周各天日期（多数情况下表头带真实日期） */
  weekDates: { weekday: number; dateKey: string }[];
  /** 出现过的节次号，升序 */
  periodNumbers: number[];
  slots: SchoolSlot[];
  fetchedAt: string;
  /** 原始课表 HTML，供前端「查看原始响应」排查使用 */
  rawHtml: string;
}

/* ------------------------------------------------------------------ *
 * 轻量 Cookie 容器（Node 的 fetch 不带 cookie jar）
 * ------------------------------------------------------------------ */

class CookieJar {
  private readonly store = new Map<string, string>();

  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      if (!pair) continue;
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      this.store.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  header(): string | undefined {
    if (this.store.size === 0) return undefined;
    return [...this.store.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  clear(): void {
    this.store.clear();
  }
}

/* ------------------------------------------------------------------ *
 * 加密
 * ------------------------------------------------------------------ */

interface PageSecrets {
  key: string;
  iv: string;
}

/** 从登录页里取出本次下发的 key / iv。 */
export function extractPageSecrets(html: string): PageSecrets {
  const key = /var\s+privateKey\s*=\s*'([^']+)'/.exec(html)?.[1];
  const iv = /var\s+privateIv\s*=\s*'([^']+)'/.exec(html)?.[1];
  if (!key || !iv) {
    throw new SchoolPortalError(
      'protocol',
      '登录页结构发生变化：未能解析出加密密钥',
      '站点可能已升级，请反馈以适配新版本',
    );
  }
  return { key, iv };
}

/**
 * 复刻 CryptoJS.AES.encrypt(data, key, { iv, mode: CBC, padding: Pkcs7 })。
 * key 长度决定 AES-128/192/256，官网上固定是 16 字节（AES-128）。
 */
export async function encryptLoginPayload(plaintext: string, secrets: PageSecrets): Promise<string> {
  const { createCipheriv } = await import('node:crypto');
  const keyBytes = Buffer.from(secrets.key, 'utf8');
  const ivBytes = Buffer.from(secrets.iv, 'utf8');
  if (![16, 24, 32].includes(keyBytes.length) || ivBytes.length !== 16) {
    throw new SchoolPortalError('protocol', '页面下发的密钥长度不合法，无法完成加密');
  }
  const cipher = createCipheriv(`aes-${keyBytes.length * 8}-cbc`, keyBytes, ivBytes);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

/* ------------------------------------------------------------------ *
 * 客户端
 * ------------------------------------------------------------------ */

export interface SchoolClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class SchoolPortalClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly jar = new CookieJar();
  private loggedIn = false;

  constructor(options: SchoolClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private async request(
    path: string,
    init: { method?: string; body?: string; follow?: boolean; referer?: string; json?: boolean } = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: init.referer ?? `${this.baseUrl}/index-index`,
    };
    const cookie = this.jar.header();
    if (cookie) headers['Cookie'] = cookie;
    if (init.json) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SchoolPortalError('network', '无法连接学校系统，请检查网络是否可访问', reason);
    }
    this.jar.absorb(response);

    // 手动跟随重定向，保证中途设置的 Cookie 不丢
    if (init.follow && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (location) {
        const next = location.startsWith('http') ? new URL(location) : new URL(location, this.baseUrl);
        response = await this.request(`${next.pathname}${next.search}`, { ...init, follow: false });
      }
    }
    return response;
  }

  /** 第一步：取登录页并解析当次密钥。 */
  async loadLoginPage(): Promise<PageSecrets> {
    const response = await this.request('/', { follow: true, referer: `${this.baseUrl}/` });
    if (!response.ok) {
      throw new SchoolPortalError('network', `登录页返回异常状态 ${response.status}`);
    }
    return extractPageSecrets(await response.text());
  }

  /** 第二步：登录。失败时抛出 auth 类错误，并把站点提示原样带出来。 */
  async login(credentials: SchoolCredentials): Promise<void> {
    const username = credentials.username.trim();
    const password = credentials.password;
    if (username.length === 0 || password.length === 0) {
      throw new SchoolPortalError('credentials', '请填写账号与密码');
    }
    // 官网前端是原样拼接，服务端也不做 urldecode；含这些字符会破坏报文切分
    if (/[&=]/.test(password) || username.includes('&')) {
      throw new SchoolPortalError(
        'credentials',
        '学校系统的登录表单不支持包含 & 或 = 的密码，请先在校内系统修改密码',
      );
    }

    const secrets = await this.loadLoginPage();
    const payload = await encryptLoginPayload(`username=${username}&passwd=${password}`, secrets);

    const response = await this.request(LOGIN_PATH, {
      method: 'POST',
      json: true,
      referer: `${this.baseUrl}/`,
      body: new URLSearchParams({ data: payload }).toString(),
    });

    const text = await response.text();
    let parsed: { status?: number; info?: string };
    try {
      parsed = JSON.parse(text) as { status?: number; info?: string };
    } catch {
      throw new SchoolPortalError('protocol', '登录接口返回了非 JSON 响应', text.slice(0, 200));
    }

    if (parsed.status !== 1) {
      this.jar.clear();
      throw new SchoolPortalError('auth', parsed.info?.trim() || '账号或密码错误');
    }
    this.loggedIn = true;
  }

  /** 第三步：取学生课表。 */
  async fetchTimetableHtml(): Promise<string> {
    if (!this.loggedIn) throw new SchoolPortalError('auth', '尚未登录学校系统');

    // 先访问一次首页，让服务端完成会话初始化
    await this.request('/index-index');

    const response = await this.request(TIMETABLE_PATH, {
      method: 'POST',
      json: true,
      body: '',
    });
    const text = await response.text();

    let parsed: { status?: number; info?: { html?: string } | string };
    try {
      parsed = JSON.parse(text) as { status?: number; info?: { html?: string } | string };
    } catch {
      throw new SchoolPortalError('protocol', '课表接口返回了非 JSON 响应', text.slice(0, 200));
    }

    if (parsed.status !== 1) {
      const message = typeof parsed.info === 'string' ? parsed.info : '';
      throw new SchoolPortalError('protocol', message || '获取课表失败', text.slice(0, 200));
    }

    const html = typeof parsed.info === 'object' ? (parsed.info?.html ?? '') : '';
    if (html.trim().length === 0) {
      throw new SchoolPortalError('parse', '课表返回内容为空，可能当前学程没有排课');
    }
    return html;
  }
}
