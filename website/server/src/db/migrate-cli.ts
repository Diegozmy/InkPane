/** 手动执行数据库迁移：npm run db:migrate */

import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { closeDatabase, getDatabase } from './client.js';
import { describeMigrations, runMigrations, schemaVersion } from './migrations.js';

try {
  const db = getDatabase();
  console.log(`数据库文件：${config.databaseFile}`);
  console.log(`迁移前版本：${schemaVersion(db)}`);
  const result = runMigrations(db);
  console.log(`迁移后版本：${result.to}（本次应用 ${result.to - result.from} 个迁移）`);
  console.log('迁移清单：');
  for (const migration of describeMigrations()) {
    console.log(`  v${migration.version}  ${migration.name}`);
  }
} catch (error) {
  logger.error('迁移失败', error);
  process.exitCode = 1;
} finally {
  closeDatabase();
}
