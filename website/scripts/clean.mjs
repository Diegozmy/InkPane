/**
 * 清理所有工作区的构建产物与缓存。
 * 不触碰 data/ 目录中的 SQLite 数据，避免误删用户日程。
 */
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'node_modules/.vite',
  'web/dist',
  'web/node_modules/.vite',
  'server/dist',
  'server/coverage',
  'web/coverage',
  'web/.tsbuildinfo',
  'server/.tsbuildinfo',
];

let removed = 0;
for (const relative of targets) {
  const absolute = join(root, relative);
  if (!existsSync(absolute)) continue;
  await rm(absolute, { recursive: true, force: true });
  console.log(`removed  ${relative}`);
  removed += 1;
}

console.log(`\n完成，共清理 ${removed} 个目录/文件。data/ 下的数据库保持不变。`);
