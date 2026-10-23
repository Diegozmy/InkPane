/**
 * 重置数据库：npm run db:reset
 *
 * 会删除当前配置的 SQLite 文件（含 WAL/SHM 附属文件）后重新建表。
 * 初始化管理员通过 /api/setup 完成；若配置了环境变量管理员，重启服务即可。
 */

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { closeDatabase, getDatabase } from './client.js';
import { runMigrations } from './migrations.js';
import { get } from './query.js';

function resetDatabase(): void {
  if (config.databaseFile === ':memory:') {
    throw new Error('当前配置使用内存数据库，无需重置');
  }

  const expected = resolve(config.databaseFile);
  const suffixes = ['', '-wal', '-shm', '-journal'];

  let removed = 0;
  for (const suffix of suffixes) {
    const candidate = `${expected}${suffix}`;
    // 双重校验：路径必须由 DATABASE_FILE 推导得出，且位于我们的数据目录语义范围内
    if (resolve(candidate) !== candidate) continue;
    if (!existsSync(candidate)) continue;
    rmSync(candidate, { force: true });
    removed += 1;
  }
  console.log(`已删除 ${removed} 个数据库文件：${expected}`);

  const db = getDatabase();
  const result = runMigrations(db);
  console.log(`已重建数据库结构（版本 ${result.to}）`);

  const owner = get<{ id: number }>(db, "SELECT id FROM users WHERE status = 'pending_setup' LIMIT 1");
  if (owner) {
    console.log('数据库已初始化，打开控制台通过 /setup 创建管理员。');
  }
}

try {
  resetDatabase();
} catch (error) {
  logger.error('重置数据库失败', error);
  process.exitCode = 1;
} finally {
  closeDatabase();
}
