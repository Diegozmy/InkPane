/**
 * 通用内存限流器。
 *
 * 设计目标只有一个：在「单机 / 个人规模」部署下把暴力尝试挡在业务逻辑之前，
 * 同时保证内存不会被随机 key（IP、用户名等）无限撑大：
 *  - 固定窗口：windowMs 内允许 maxAttempts 次尝试；
 *  - 超限封禁：blockMs 内直接拒绝，并给出 retryAfterSeconds；
 *  - 容量上限：最多保留 maxEntries 个 key，满时先清过期项，再淘汰最旧项；
 *  - 可注入时钟，便于测试窗口/过期行为。
 *
 * 注意：进程内状态。多进程/多实例部署时每进程各算各的，需要更严格限流时应换成 Redis 等共享存储。
 */

export interface RateLimiterOptions {
  /** 窗口内允许的尝试次数 */
  maxAttempts: number;
  /** 固定窗口长度（毫秒） */
  windowMs: number;
  /** 超限后的封禁时长（毫秒），默认与 windowMs 相同 */
  blockMs?: number;
  /** 最多保留的 key 数量，默认 10000 */
  maxEntries?: number;
  /** 可注入的时钟，默认 Date.now */
  now?: () => number;
}

export interface RateLimitDecision {
  /** 本次是否应被拒绝 */
  blocked: boolean;
  /** 被拒绝时建议等待的秒数（未拒绝为 0） */
  retryAfterSeconds: number;
}

interface Entry {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
/** 每 N 次操作做一次全量过期清理，避免每个请求都 O(n) 扫描 */
const SWEEP_EVERY_OPS = 128;

function toRetryAfterSeconds(blockedUntil: number, now: number): number {
  return Math.max(1, Math.ceil((blockedUntil - now) / 1000));
}

export class RateLimiter {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private opsSinceSweep = 0;

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
      throw new Error('RateLimiter.maxAttempts 必须是正整数');
    }
    if (!Number.isFinite(options.windowMs) || options.windowMs < 1) {
      throw new Error('RateLimiter.windowMs 必须是正数');
    }
    if (
      options.maxEntries !== undefined &&
      (!Number.isInteger(options.maxEntries) || options.maxEntries < 1)
    ) {
      throw new Error('RateLimiter.maxEntries 必须是正整数');
    }
    this.maxAttempts = options.maxAttempts;
    this.windowMs = options.windowMs;
    this.blockMs = options.blockMs ?? options.windowMs;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** 记录一次尝试；超过窗口配额时返回封禁信息。 */
  hit(key: string, options: { blockAtLimit?: boolean } = {}): RateLimitDecision {
    const now = this.now();
    this.sweepIfNeeded();

    let entry = this.entries.get(key);
    if (entry && this.isExpired(entry, now)) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      entry = { count: 0, firstAt: now, blockedUntil: 0 };
      this.entries.set(key, entry);
      this.evictIfFull();
    }

    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfterSeconds: toRetryAfterSeconds(entry.blockedUntil, now) };
    }

    entry.count += 1;
    // 默认「配额用满后继续请求才封禁」（5 次/窗口 → 第 6 次 429）；
    // blockAtLimit = true 时用满即封禁（登录失败计数沿用旧语义：第 5 次失败后封禁）。
    const shouldBlock = options.blockAtLimit
      ? entry.count >= this.maxAttempts
      : entry.count > this.maxAttempts;
    if (shouldBlock) {
      entry.blockedUntil = now + this.blockMs;
      return { blocked: true, retryAfterSeconds: toRetryAfterSeconds(entry.blockedUntil, now) };
    }
    return { blocked: false, retryAfterSeconds: 0 };
  }

  /** 只查询是否已被封禁，不消耗配额。 */
  check(key: string): RateLimitDecision {
    const now = this.now();
    this.sweepIfNeeded();
    const entry = this.entries.get(key);
    if (!entry) return { blocked: false, retryAfterSeconds: 0 };
    if (this.isExpired(entry, now)) {
      this.entries.delete(key);
      return { blocked: false, retryAfterSeconds: 0 };
    }
    if (entry.blockedUntil > now) {
      return { blocked: true, retryAfterSeconds: toRetryAfterSeconds(entry.blockedUntil, now) };
    }
    return { blocked: false, retryAfterSeconds: 0 };
  }

  /** 清除单个 key（登录成功等场景）。 */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** 清空全部状态（测试或热重载用）。 */
  clear(): void {
    this.entries.clear();
    this.opsSinceSweep = 0;
  }

  /** 当前保留的 key 数量。 */
  get size(): number {
    return this.entries.size;
  }

  /** 该 key 当前是否被跟踪（测试与诊断用）。 */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** 主动清理已过期条目，返回清理数量。 */
  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, now)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    this.opsSinceSweep = 0;
    return removed;
  }

  private isExpired(entry: Entry, now: number): boolean {
    if (entry.blockedUntil > now) return false;
    return now - entry.firstAt > this.windowMs;
  }

  private sweepIfNeeded(): void {
    this.opsSinceSweep += 1;
    if (this.opsSinceSweep >= SWEEP_EVERY_OPS) this.sweep();
  }

  private evictIfFull(): void {
    if (this.entries.size <= this.maxEntries) return;
    // 先清过期项；如果全是活跃项，再淘汰 firstAt 最旧的 key。
    this.sweep();
    if (this.entries.size <= this.maxEntries) return;
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.firstAt < oldestAt) {
        oldestAt = entry.firstAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.entries.delete(oldestKey);
  }
}
