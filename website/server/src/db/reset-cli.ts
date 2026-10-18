/**
 * 重置数据库：npm run db:reset
 *
 * 会删除当前配置的 SQLite 文件（含 WAL/SHM 附属文件）后重新建表并写入演示数据。
 * 删除前会校验目标路径确实等于 DATABASE_FILE 解析后的绝对路径，
 * 且拒绝 ':memory:'，避免误删。
 */

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { closeDatabase, getDatabase } from './client.js';
import { runMigrations } from './migrations.js';
import { seedDemoData } from './seed.js';

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

  const seeded = seedDemoData(db);
  if (seeded.seeded) {
    console.log(`已写入 ${seeded.categoryCount} 个分类、${seeded.eventCount} 条演示日程`);
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
