/** 待办仓储：SQL 读写与行 ↔ 实体映射。 */

import { fromBool, type SqliteDatabase } from '../../db/client.js';
import { all, get, run, type SqlValue } from '../../db/query.js';
import { nowIso } from '../../lib/clock.js';
import type { Priority, Todo } from '../../domain/types.js';

export interface TodoRow {
  id: number;
  title: string;
  notes: string;
  done: number;
  priority: string;
  due_date: string | null;
  category_id: number | null;
  sort_order: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const TODO_COLUMNS =
  'id, title, notes, done, priority, due_date, category_id, sort_order, completed_at, created_at, updated_at';

function toTodo(row: TodoRow): Todo {
  return {
    id: Number(row.id),
    title: row.title,
    notes: row.notes ?? '',
    done: fromBool(row.done),
    priority: row.priority as Priority,
    dueDate: row.due_date,
    categoryId: row.category_id === null ? null : Number(row.category_id),
    sortOrder: Number(row.sort_order),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface TodoFilters {
  done?: boolean;
  /** 截止日期闭区间（YYYY-MM-DD），两者同时给出才生效 */
  dueFrom?: string;
  dueTo?: string;
  limit: number;
  offset: number;
}

export interface TodoListResult {
  items: Todo[];
  total: number;
}

/** 列表排序固定为：未完成在前 → sort_order 升序 → 创建时间倒序。 */
export function listTodos(db: SqliteDatabase, userId: number, filters: TodoFilters): TodoListResult {
  const where: string[] = ['user_id = ?'];
  const params: SqlValue[] = [userId];

  if (filters.done !== undefined) {
    where.push('done = ?');
    params.push(filters.done ? 1 : 0);
  }
  if (filters.dueFrom && filters.dueTo) {
    where.push('due_date IS NOT NULL AND due_date >= ? AND due_date <= ?');
    params.push(filters.dueFrom, filters.dueTo);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = Number(
    get<{ count: number }>(db, `SELECT COUNT(*) AS count FROM todos ${whereSql}`, params)?.count ?? 0,
  );
  const rows = all<TodoRow>(
    db,
    `SELECT ${TODO_COLUMNS} FROM todos ${whereSql}
     ORDER BY done ASC, sort_order ASC, created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset],
  );

  return { items: rows.map(toTodo), total };
}

/** 设备屏幕用：未完成待办，按用户排序取前 N 条。 */
export function listOpenTodos(db: SqliteDatabase, userId: number, limit: number): Todo[] {
  return all<TodoRow>(
    db,
    `SELECT ${TODO_COLUMNS} FROM todos WHERE done = 0 AND user_id = ?
     ORDER BY sort_order ASC, created_at DESC, id DESC
     LIMIT ?`,
    [userId, limit],
  ).map(toTodo);
}

/** 全量列表（重排后返回用），排序与分页列表一致。 */
export function listAllTodos(db: SqliteDatabase, userId: number): Todo[] {
  return all<TodoRow>(
    db,
    `SELECT ${TODO_COLUMNS} FROM todos WHERE user_id = ?
     ORDER BY done ASC, sort_order ASC, created_at DESC, id DESC`,
    [userId],
  ).map(toTodo);
}

export function findTodo(db: SqliteDatabase, userId: number, id: number): Todo | null {
  const row = get<TodoRow>(
    db,
    `SELECT ${TODO_COLUMNS} FROM todos WHERE id = ? AND user_id = ?`,
    [id, userId],
  );
  return row ? toTodo(row) : null;
}

/** 默认排序值：追加到末尾，步长 10。 */
export function nextSortOrder(db: SqliteDatabase, userId: number): number {
  const row = get<{ value: number | null }>(
    db,
    'SELECT MAX(sort_order) AS value FROM todos WHERE user_id = ?',
    [userId],
  );
  return Number(row?.value ?? 0) + 10;
}

export interface TodoWriteModel {
  title: string;
  notes: string;
  done: boolean;
  priority: Priority;
  dueDate: string | null;
  categoryId: number | null;
  sortOrder: number;
  completedAt: string | null;
}

const TODO_WRITE_CLAUSE =
  'title = ?, notes = ?, done = ?, priority = ?, due_date = ?, category_id = ?, ' +
  'sort_order = ?, completed_at = ?';

function writeValues(model: TodoWriteModel): SqlValue[] {
  return [
    model.title,
    model.notes,
    model.done ? 1 : 0,
    model.priority,
    model.dueDate,
    model.categoryId,
    model.sortOrder,
    model.completedAt,
  ];
}

export function insertTodo(
  db: SqliteDatabase,
  userId: number,
  model: TodoWriteModel,
): Todo {
  const timestamp = nowIso();
  const result = run(
    db,
    `INSERT INTO todos (user_id, ${TODO_WRITE_CLAUSE.replace(/ = \?/g, '')}, created_at, updated_at)
     VALUES (?, ${new Array(8).fill('?').join(', ')}, ?, ?)`,
    [userId, ...writeValues(model), timestamp, timestamp],
  );
  const created = findTodo(db, userId, result.lastInsertRowid);
  if (!created) throw new Error('待办写入后无法读回');
  return created;
}

export function updateTodo(
  db: SqliteDatabase,
  userId: number,
  id: number,
  model: TodoWriteModel,
): Todo | null {
  const result = run(
    db,
    `UPDATE todos SET ${TODO_WRITE_CLAUSE}, updated_at = ? WHERE id = ? AND user_id = ?`,
    [...writeValues(model), nowIso(), id, userId],
  );
  if (result.changes === 0) return null;
  return findTodo(db, userId, id);
}

export function deleteTodo(db: SqliteDatabase, userId: number, id: number): boolean {
  return run(db, 'DELETE FROM todos WHERE id = ? AND user_id = ?', [id, userId]).changes > 0;
}

/** 批量写排序值；不存在的 id 直接跳过。 */
export function updateSortOrder(
  db: SqliteDatabase,
  userId: number,
  id: number,
  sortOrder: number,
): void {
  run(db, 'UPDATE todos SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?', [
    sortOrder,
    nowIso(),
    id,
    userId,
  ]);
}
