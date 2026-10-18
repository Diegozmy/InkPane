/** 写入演示数据：npm run db:seed（数据库已有日程时不会重复写入） */

import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { closeDatabase, getDatabase } from './client.js';
import { runMigrations } from './migrations.js';
import { seedDemoData } from './seed.js';

try {
  const db = getDatabase();
  runMigrations(db);
  const result = seedDemoData(db);
  if (result.seeded) {
    console.log(`已写入 ${result.categoryCount} 个分类、${result.eventCount} 条日程`);
  } else {
    console.log('数据库已有日程数据，跳过演示数据写入。');
    console.log(`数据库文件：${config.databaseFile}`);
    console.log('如需重置，请执行 npm run db:reset');
  }
} catch (error) {
  logger.error('写入演示数据失败', error);
  process.exitCode = 1;
} finally {
  closeDatabase();
}
