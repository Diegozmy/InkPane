/** 通用内存限流器的边界测试：配额、封禁、窗口过期、容量淘汰。 */

import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/lib/rate-limit.js';

describe('RateLimiter', () => {
  it('窗口内允许 maxAttempts 次，下一次被拒绝并给出 Retry-After 秒数', () => {
    let now = 0;
    const limiter = new RateLimiter({
      maxAttempts: 3,
      windowMs: 1_000,
      blockMs: 5_000,
      now: () => now,
    });

    for (let index = 0; index < 3; index += 1) {
      expect(limiter.hit('ip|user').blocked).toBe(false);
    }

    const blocked = limiter.hit('ip|user');
    expect(blocked.blocked).toBe(true);
    expect(blocked.retryAfterSeconds).toBe(5);

    now += 1_000;
    expect(limiter.check('ip|user')).toMatchObject({ blocked: true, retryAfterSeconds: 4 });

    now += 5_000;
    expect(limiter.check('ip|user').blocked).toBe(false);
    // 封禁与窗口都过去后重新计数
    expect(limiter.hit('ip|user').blocked).toBe(false);
  });

  it('blockAtLimit 用满即封禁（登录失败计数沿用旧语义）', () => {
    const now = 0;
    const limiter = new RateLimiter({
      maxAttempts: 5,
      windowMs: 900_000,
      now: () => now,
    });

    for (let index = 0; index < 4; index += 1) {
      expect(limiter.hit('k', { blockAtLimit: true }).blocked).toBe(false);
    }
    // 第 5 次失败写入封禁（本次仍由调用方返回 401），下一次 check 立即拒绝
    expect(limiter.hit('k', { blockAtLimit: true }).blocked).toBe(true);
    expect(limiter.check('k').blocked).toBe(true);
    expect(limiter.check('k').retryAfterSeconds).toBe(900);
  });

  it('窗口过期后旧计数失效', () => {
    let now = 0;
    const limiter = new RateLimiter({ maxAttempts: 2, windowMs: 1_000, now: () => now });
    limiter.hit('k');
    limiter.hit('k');
    expect(limiter.hit('k').blocked).toBe(true);

    now = 1_001;
    expect(limiter.hit('k').blocked).toBe(false);
  });

  it('主动清理过期条目', () => {
    let now = 0;
    const limiter = new RateLimiter({ maxAttempts: 10, windowMs: 1_000, now: () => now });
    limiter.hit('a');
    limiter.hit('b');
    expect(limiter.size).toBe(2);

    now = 2_000;
    expect(limiter.sweep()).toBe(2);
    expect(limiter.size).toBe(0);
  });

  it('容量上限：满时淘汰最旧 key，size 不超过 maxEntries', () => {
    let now = 0;
    const limiter = new RateLimiter({
      maxAttempts: 10,
      windowMs: 60_000,
      maxEntries: 3,
      now: () => now,
    });

    for (const key of ['a', 'b', 'c']) {
      now += 1;
      limiter.hit(key);
    }
    expect(limiter.size).toBe(3);

    now += 1;
    limiter.hit('d');
    expect(limiter.size).toBe(3);
    // 最旧的 a 被淘汰，新的 b/c/d 仍在
    expect(limiter.has('a')).toBe(false);
    expect(limiter.has('b')).toBe(true);
    expect(limiter.has('d')).toBe(true);
  });

  it('reset 与 clear 清理状态', () => {
    const now = 0;
    const limiter = new RateLimiter({ maxAttempts: 1, windowMs: 1_000, now: () => now });
    limiter.hit('a');
    limiter.hit('b');
    expect(limiter.size).toBe(2);

    limiter.reset('a');
    expect(limiter.has('a')).toBe(false);
    limiter.clear();
    expect(limiter.size).toBe(0);
  });

  it('校验构造参数', () => {
    expect(() => new RateLimiter({ maxAttempts: 0, windowMs: 1_000 })).toThrow();
    expect(() => new RateLimiter({ maxAttempts: 1, windowMs: 0 })).toThrow();
    expect(
      () => new RateLimiter({ maxAttempts: 1, windowMs: 1_000, maxEntries: 0 }),
    ).toThrow();
  });
});
