/** 写入演示数据：npm run db:seed [-- --user <username>] */

import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { closeDatabase, getDatabase } from './client.js';
import { runMigrations } from './migrations.js';
import { seedDemoData } from './seed.js';
import { all } from './query.js';

function resolveUserId(db: ReturnType<typeof getDatabase>): number {
  const requested = process.argv.find((arg) => arg.startsWith('--user='))?.slice('--user='.length);
  const users = all<{ id: number; username: string; status: string }>(
    db,
    'SELECT id, username, status FROM users ORDER BY id ASC',
  );
  if (users.length === 0) throw new Error('数据库中还没有用户，请先通过 /api/setup 初始化管理员');
  if (requested) {
    const found = users.find((user) => user.username.toLowerCase() === requested.toLowerCase());
    if (!found) throw new Error(`用户不存在：${requested}`);
    return Number(found.id);
  }
  if (users.length === 1) return Number(users[0]!.id);
  throw new Error(
    `数据库中有多个用户，请用 --user=<username> 指定；可选：${users
      .map((user) => user.username)
      .join(', ')}`,
  );
}

try {
  const db = getDatabase();
  runMigrations(db);
  const userId = resolveUserId(db);
  const result = seedDemoData(db, userId);
  if (result.seeded) {
    console.log(`已为用户 ${userId} 写入 ${result.categoryCount} 个分类、${result.eventCount} 条日程`);
  } else {
    console.log('该用户已有日程数据，跳过演示数据写入。');
    console.log(`数据库文件：${config.databaseFile}`);
    console.log('如需重置，请执行 npm run db:reset');
  }
} catch (error) {
  logger.error('写入演示数据失败', error);
  process.exitCode = 1;
} finally {
  closeDatabase();
}
