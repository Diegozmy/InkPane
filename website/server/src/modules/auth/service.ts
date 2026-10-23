/**
 * 账户与初始化。
 *
 * 单用户时代的数据在 v4 迁移时被归到一个 pending owner；首次 /api/setup
 * 由管理员认领。之后所有账号都由管理员创建，不开放自助注册。
 */

import { get, all, run } from '../../db/query.js';
import { transaction, type SqliteDatabase } from '../../db/client.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../http/errors.js';
import { nowIso } from '../../lib/clock.js';
import { readSetting, writeSetting } from '../../lib/app-settings.js';
import { hashPassword, validatePassword, verifyPassword } from './password.js';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'pending_setup' | 'active' | 'disabled';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  timezone: string;
}

export interface UserSummary extends AuthUser {
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  deviceCount: number;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string | null;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  device_count?: number;
}

const PUBLIC_USER_COLUMNS = [
  'u.id',
  'u.username',
  'u.display_name',
  'u.role',
  'u.status',
  'u.created_at',
  'u.updated_at',
  'u.last_login_at',
  '(SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS device_count',
].join(', ');

export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

function timezoneOf(db: SqliteDatabase, userId: number): string {
  return readSetting(db, userId, 'display.timezone')?.trim() || DEFAULT_TIMEZONE;
}

function toAuthUser(db: SqliteDatabase, row: UserRow): AuthUser {
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name || row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
    status: row.status as UserStatus,
    timezone: timezoneOf(db, Number(row.id)),
  };
}

function toSummary(db: SqliteDatabase, row: UserRow): UserSummary {
  return {
    ...toAuthUser(db, row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    deviceCount: Number(row.device_count ?? 0),
  };
}

export function findUserByUsername(db: SqliteDatabase, username: string): UserRow | null {
  return (
    get<UserRow>(db, 'SELECT * FROM users WHERE username = ? COLLATE NOCASE', [username]) ?? null
  );
}

export function findUserById(db: SqliteDatabase, userId: number): UserRow | null {
  return get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', [userId]) ?? null;
}

export function getAuthUser(db: SqliteDatabase, userId: number): AuthUser {
  const row = findUserById(db, userId);
  if (!row) throw new NotFoundError('用户不存在');
  return toAuthUser(db, row);
}

export function listUserSummaries(db: SqliteDatabase): UserSummary[] {
  return all<UserRow>(
    db,
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users u ORDER BY u.role ASC, u.id ASC`,
  ).map((row) => toSummary(db, row));
}

export function getUserSummary(db: SqliteDatabase, userId: number): UserSummary {
  const row = get<UserRow>(
    db,
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users u WHERE u.id = ?`,
    [userId],
  );
  if (!row) throw new NotFoundError('用户不存在');
  return toSummary(db, row);
}

export function countActiveAdmins(db: SqliteDatabase): number {
  const row = get<{ count: number }>(
    db,
    "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'",
  );
  return Number(row?.count ?? 0);
}

export function setupRequired(db: SqliteDatabase): boolean {
  return countActiveAdmins(db) === 0;
}

export function findPendingOwner(db: SqliteDatabase): UserRow | null {
  return (
    get<UserRow>(
      db,
      "SELECT * FROM users WHERE status = 'pending_setup' ORDER BY id ASC LIMIT 1",
    ) ?? null
  );
}

export interface CreateUserInput {
  username: string;
  password: string;
  displayName?: string;
  role?: UserRole;
  timezone?: string;
}

export type SetupInput = CreateUserInput;

export function assertUsernameAvailable(
  db: SqliteDatabase,
  username: string,
  exceptUserId?: number,
): void {
  const existing = findUserByUsername(db, username);
  if (existing && existing.id !== exceptUserId) {
    throw new ConflictError('该用户名已被使用');
  }
}

function validateUsername(username: string): void {
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw new ValidationError('用户名需为 3–32 位字母、数字、点、下划线或短横线');
  }
}

function displayNameOf(input: { username: string; displayName?: string }): string {
  const value = input.displayName?.trim();
  return value && value.length > 0 ? value.slice(0, 40) : input.username;
}

export async function createUser(
  db: SqliteDatabase,
  input: CreateUserInput,
): Promise<UserSummary> {
  validateUsername(input.username);
  const passwordError = validatePassword(input.password);
  if (passwordError) throw new ValidationError(passwordError);
  assertUsernameAvailable(db, input.username);
  const passwordHash = await hashPassword(input.password);
  const timestamp = nowIso();
  const role: UserRole = input.role === 'admin' ? 'admin' : 'user';

  const result = run(
    db,
    `INSERT INTO users (username, display_name, password_hash, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [
      input.username,
      displayNameOf(input),
      passwordHash,
      role,
      timestamp,
      timestamp,
    ],
  );
  if (input.timezone) writeSetting(db, result.lastInsertRowid, 'display.timezone', input.timezone);
  return getUserSummary(db, result.lastInsertRowid);
}

/** 首次初始化：认领 pending owner；若没有 pending 且没有管理员，则新建管理员。 */
export async function setupAdmin(db: SqliteDatabase, input: SetupInput): Promise<AuthUser> {
  if (!setupRequired(db)) throw new ConflictError('系统已经完成初始化');
  validateUsername(input.username);
  const passwordError = validatePassword(input.password);
  if (passwordError) throw new ValidationError(passwordError);
  const passwordHash = await hashPassword(input.password);
  const timestamp = nowIso();
  const pending = findPendingOwner(db);
  assertUsernameAvailable(db, input.username, pending?.id);

  return transaction(db, () => {
    let userId: number;
    if (pending) {
      userId = Number(pending.id);
      const changed = run(
        db,
        `UPDATE users SET username = ?, display_name = ?, password_hash = ?, role = 'admin',
           status = 'active', updated_at = ? WHERE id = ? AND status = 'pending_setup'`,
        [input.username, displayNameOf(input), passwordHash, timestamp, userId],
      );
      if (changed.changes === 0) throw new ConflictError('系统已经完成初始化');
    } else {
      if (countActiveAdmins(db) > 0) throw new ConflictError('系统已经完成初始化');
      const result = run(
        db,
        `INSERT INTO users (username, display_name, password_hash, role, status, created_at, updated_at)
         VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
        [input.username, displayNameOf(input), passwordHash, timestamp, timestamp],
      );
      userId = result.lastInsertRowid;
    }
    writeSetting(db, userId, 'display.timezone', input.timezone?.trim() || DEFAULT_TIMEZONE);
    return getAuthUser(db, userId);
  });
}

/** 可选的环境变量引导管理员；已存在管理员时不做任何事。 */
export async function bootstrapAdminFromEnv(
  db: SqliteDatabase,
  username: string,
  password: string,
): Promise<AuthUser | null> {
  if (username.trim() === '' || password.length === 0) return null;
  if (!setupRequired(db)) return null;

  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(`INKPANE_ADMIN_PASSWORD 不符合要求：${passwordError}`);
  validateUsername(username);
  const passwordHash = await hashPassword(password);
  const timestamp = nowIso();
  const pending = findPendingOwner(db);
  assertUsernameAvailable(db, username, pending?.id);

  return transaction(db, () => {
    let userId: number;
    if (pending) {
      userId = Number(pending.id);
      run(
        db,
        `UPDATE users SET username = ?, display_name = ?, password_hash = ?, role = 'admin',
           status = 'active', updated_at = ? WHERE id = ?`,
        [username, username, passwordHash, timestamp, userId],
      );
    } else {
      const result = run(
        db,
        `INSERT INTO users (username, display_name, password_hash, role, status, created_at, updated_at)
         VALUES (?, ?, ?, 'admin', 'active', ?, ?)`,
        [username, username, passwordHash, timestamp, timestamp],
      );
      userId = result.lastInsertRowid;
    }
    if (readSetting(db, userId, 'display.timezone') === null) {
      writeSetting(db, userId, 'display.timezone', DEFAULT_TIMEZONE);
    }
    return getAuthUser(db, userId);
  });
}

export interface UpdateUserPatch {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
}

function assertNotLastAdmin(
  db: SqliteDatabase,
  target: UserRow,
  next: { role?: UserRole; status?: UserStatus },
): void {
  const currentlyAdmin = target.role === 'admin' && target.status === 'active';
  const nextAdmin =
    (next.role ?? (target.role as UserRole)) === 'admin' &&
    (next.status ?? (target.status as UserStatus)) === 'active';
  if (currentlyAdmin && !nextAdmin && countActiveAdmins(db) <= 1) {
    throw new ForbiddenError('不能停用或降级最后一个管理员');
  }
}

export function updateUser(
  db: SqliteDatabase,
  userId: number,
  patch: UpdateUserPatch,
): UserSummary {
  const target = findUserById(db, userId);
  if (!target) throw new NotFoundError('用户不存在');
  assertNotLastAdmin(db, target, patch);

  const displayName =
    patch.displayName === undefined
      ? target.display_name
      : patch.displayName.trim().slice(0, 40) || target.username;
  const role: UserRole = patch.role ?? (target.role as UserRole);
  const status: UserStatus = patch.status ?? (target.status as UserStatus);

  run(
    db,
    'UPDATE users SET display_name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?',
    [displayName, role, status, nowIso(), userId],
  );
  if (status !== 'active') {
    run(db, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [
      nowIso(),
      userId,
    ]);
  }
  return getUserSummary(db, userId);
}

export async function resetPassword(
  db: SqliteDatabase,
  userId: number,
  password: string,
): Promise<void> {
  const target = findUserById(db, userId);
  if (!target) throw new NotFoundError('用户不存在');
  const passwordError = validatePassword(password);
  if (passwordError) throw new ValidationError(passwordError);
  const passwordHash = await hashPassword(password);
  run(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    passwordHash,
    nowIso(),
    userId,
  ]);
  run(db, 'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [
    nowIso(),
    userId,
  ]);
}

export async function changeOwnPassword(
  db: SqliteDatabase,
  userId: number,
  currentPassword: string,
  newPassword: string,
  currentSessionId: number,
): Promise<void> {
  const target = findUserById(db, userId);
  if (!target) throw new NotFoundError('用户不存在');
  const valid = await verifyPassword(currentPassword, target.password_hash);
  if (!valid) throw new ValidationError('当前密码不正确');
  const passwordError = validatePassword(newPassword);
  if (passwordError) throw new ValidationError(passwordError);
  const passwordHash = await hashPassword(newPassword);
  run(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    passwordHash,
    nowIso(),
    userId,
  ]);
  run(
    db,
    'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
    [nowIso(), userId, currentSessionId],
  );
}

export async function authenticate(
  db: SqliteDatabase,
  username: string,
  password: string,
): Promise<AuthUser | null> {
  const row = findUserByUsername(db, username);
  if (!row || row.status !== 'active' || !row.password_hash) {
    // 仍执行一次哈希，减少“用户不存在”和“密码错误”的时序差异。
    await hashPassword(password);
    return null;
  }
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return null;
  run(db, 'UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), Number(row.id)]);
  return getAuthUser(db, Number(row.id));
}

export function userExistsByUsername(db: SqliteDatabase, username: string): boolean {
  return findUserByUsername(db, username) !== null;
}

export function updateDisplayName(
  db: SqliteDatabase,
  userId: number,
  displayName: string,
): AuthUser {
  const value = displayName.trim().slice(0, 40);
  if (value.length === 0) throw new ValidationError('显示名不能为空');
  run(db, 'UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?', [
    value,
    nowIso(),
    userId,
  ]);
  return getAuthUser(db, userId);
}
