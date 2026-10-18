/** 分类模块：仓储、服务、路由集中在一个文件（该领域规模小且无复杂规则）。 */

import { Router } from 'express';
import { getDatabase, type SqliteDatabase } from '../db/client.js';
import { all, get, run } from '../db/query.js';
import { CATEGORY_COLUMNS, toCategory, type CategoryRow } from '../db/rows.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { asyncHandler } from '../http/async-handler.js';
import { categoryCreateSchema, categoryUpdateSchema, idParamSchema } from '../domain/schemas.js';
import type { Category } from '../domain/types.js';

/* ------------------------------ 仓储 ------------------------------ */

const DEFAULT_SORT_STEP = 10;

export function listCategories(db: SqliteDatabase = getDatabase()): Category[] {
  return all<CategoryRow>(
    db,
    `SELECT ${CATEGORY_COLUMNS} FROM categories ORDER BY sort_order ASC, id ASC`,
  ).map(toCategory);
}

export function findCategory(db: SqliteDatabase, id: number): Category | null {
  const row = get<CategoryRow>(db, `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = ?`, [id]);
  return row ? toCategory(row) : null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/* ------------------------------ 服务 ------------------------------ */

export function createCategory(
  input: { name: string; color: string; icon?: string | null; sortOrder?: number },
  db: SqliteDatabase = getDatabase(),
): Category {
  const timestamp = new Date().toISOString();
  const sortOrder =
    input.sortOrder ??
    (get<{ value: number | null }>(db, 'SELECT MAX(sort_order) AS value FROM categories')?.value ??
      0) + DEFAULT_SORT_STEP;

  try {
    const result = run(
      db,
      `INSERT INTO categories (name, color, icon, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.name, input.color, input.icon ?? null, sortOrder, timestamp, timestamp],
    );
    const created = findCategory(db, result.lastInsertRowid);
    if (!created) throw new Error('分类写入后无法读回');
    return created;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`已存在同名分类「${input.name}」`);
    }
    throw error;
  }
}

export function updateCategory(
  id: number,
  patch: { name?: string; color?: string; icon?: string | null; sortOrder?: number },
  db: SqliteDatabase = getDatabase(),
): Category {
  const existing = findCategory(db, id);
  if (!existing) throw new NotFoundError(`分类 ${id} 不存在`);

  try {
    run(
      db,
      `UPDATE categories SET name = ?, color = ?, icon = ?, sort_order = ?, updated_at = ?
       WHERE id = ?`,
      [
        patch.name ?? existing.name,
        patch.color ?? existing.color,
        patch.icon === undefined ? existing.icon : patch.icon,
        patch.sortOrder ?? existing.sortOrder,
        new Date().toISOString(),
        id,
      ],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`已存在同名分类「${patch.name ?? existing.name}」`);
    }
    throw error;
  }

  const updated = findCategory(db, id);
  if (!updated) throw new NotFoundError(`分类 ${id} 不存在`);
  return updated;
}

export interface DeleteCategoryResult {
  id: number;
  detachedEventCount: number;
}

export function deleteCategory(
  id: number,
  db: SqliteDatabase = getDatabase(),
): DeleteCategoryResult {
  const existing = findCategory(db, id);
  if (!existing) throw new NotFoundError(`分类 ${id} 不存在`);

  const affected = get<{ count: number }>(
    db,
    'SELECT COUNT(*) AS count FROM events WHERE category_id = ?',
    [id],
  );

  // 外键为 ON DELETE SET NULL，删除分类后原事件会变为“未分类”而非被删除
  run(db, 'DELETE FROM categories WHERE id = ?', [id]);

  return { id, detachedEventCount: Number(affected?.count ?? 0) };
}

export function reorderCategories(
  orderedIds: readonly number[],
  db: SqliteDatabase = getDatabase(),
): Category[] {
  const existing = new Set(listCategories(db).map((category) => category.id));
  for (const id of orderedIds) {
    if (!existing.has(id)) throw new ValidationError(`分类 ${id} 不存在，无法排序`);
  }
  const timestamp = new Date().toISOString();
  orderedIds.forEach((id, index) => {
    run(db, 'UPDATE categories SET sort_order = ?, updated_at = ? WHERE id = ?', [
      (index + 1) * DEFAULT_SORT_STEP,
      timestamp,
      id,
    ]);
  });
  return listCategories(db);
}

/* ------------------------------ 路由 ------------------------------ */

export function createCategoriesRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((_req, res) => {
      res.json({ data: listCategories() });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const input = categoryCreateSchema.parse(req.body);
      const created = createCategory(input);
      res.status(201).json({ data: created });
    }),
  );

  router.put(
    '/order',
    asyncHandler((req, res) => {
      const body = req.body as { ids?: unknown };
      if (!Array.isArray(body?.ids) || body.ids.some((id) => typeof id !== 'number')) {
        throw new ValidationError('请求体需为 { ids: number[] }');
      }
      res.json({ data: reorderCategories(body.ids as number[]) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      const category = findCategory(getDatabase(), id);
      if (!category) throw new NotFoundError(`分类 ${id} 不存在`);
      res.json({ data: category });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      const input = categoryUpdateSchema.parse(req.body);
      res.json({ data: updateCategory(id, input) });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      res.json({ data: deleteCategory(id) });
    }),
  );

  return router;
}
