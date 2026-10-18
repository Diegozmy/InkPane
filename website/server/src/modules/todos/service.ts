/**
 * 待办服务。
 *
 * 「今天/本周」按显示设置里的 display.timezone 计算，而不是服务器本机时区，
 * 因此把服务部署到任何时区，过滤结果都与用户看到的墨水屏一致。
 */

import { getDatabase, type SqliteDatabase } from '../../db/client.js';
import { NotFoundError, ValidationError } from '../../http/errors.js';
import { nowIso } from '../../lib/clock.js';
import { addDaysToDateKey } from '../../domain/time.js';
import { todayDateKey } from '../../domain/display-time.js';
import type { TodoCreateInput, TodoListQueryInput, TodoUpdateInput } from '../../domain/schemas.js';
import type { Priority, Todo } from '../../domain/types.js';
import { findCategory } from '../categories.js';
import { readDisplayTimezone } from '../display/settings.js';
import * as repo from './repository.js';

const DEFAULT_LIMIT = 200;

export interface TodoListResult {
  items: Todo[];
  total: number;
  limit: number;
  offset: number;
}

/** 分类不存在时按「校验失败」处理，与事件模块保持一致。 */
function assertCategoryExists(db: SqliteDatabase, categoryId: number | null | undefined): void {
  if (categoryId === null || categoryId === undefined) return;
  if (!findCategory(db, categoryId)) {
    throw new ValidationError(`分类 ${categoryId} 不存在`);
  }
}

export function listTodoItems(
  query: TodoListQueryInput,
  db: SqliteDatabase = getDatabase(),
): TodoListResult {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;

  let dueFrom: string | undefined;
  let dueTo: string | undefined;
  if (query.due === 'today') {
    dueFrom = todayDateKey(readDisplayTimezone(db));
    dueTo = dueFrom;
  } else if (query.due === 'week') {
    dueFrom = todayDateKey(readDisplayTimezone(db));
    // 「本周」= 今天起 7 天（含当天）
    dueTo = addDaysToDateKey(dueFrom, 6);
  }

  const filters: repo.TodoFilters = { limit, offset };
  if (query.done !== undefined) filters.done = query.done;
  if (dueFrom && dueTo) {
    filters.dueFrom = dueFrom;
    filters.dueTo = dueTo;
  }

  const { items, total } = repo.listTodos(db, filters);
  return { items, total, limit, offset };
}

export function getTodoOrThrow(id: number, db: SqliteDatabase = getDatabase()): Todo {
  const todo = repo.findTodo(db, id);
  if (!todo) throw new NotFoundError(`待办 ${id} 不存在`);
  return todo;
}

export function createTodo(input: TodoCreateInput, db: SqliteDatabase = getDatabase()): Todo {
  assertCategoryExists(db, input.categoryId);
  const model: repo.TodoWriteModel = {
    title: input.title,
    notes: input.notes ?? '',
    done: false,
    priority: (input.priority ?? 'normal') as Priority,
    dueDate: input.dueDate ?? null,
    categoryId: input.categoryId ?? null,
    sortOrder: input.sortOrder ?? repo.nextSortOrder(db),
    completedAt: null,
  };
  return repo.insertTodo(db, model);
}

export function updateTodoById(
  id: number,
  patch: TodoUpdateInput,
  db: SqliteDatabase = getDatabase(),
): Todo {
  const existing = getTodoOrThrow(id, db);
  if (patch.categoryId !== undefined) assertCategoryExists(db, patch.categoryId);

  // done 显式切换时同步 completedAt；只改其他字段则保留原完成时间
  const completedAt =
    patch.done === undefined ? existing.completedAt : patch.done ? nowIso() : null;

  const model: repo.TodoWriteModel = {
    title: patch.title ?? existing.title,
    notes: patch.notes ?? existing.notes,
    done: patch.done ?? existing.done,
    priority: patch.priority ?? existing.priority,
    dueDate: patch.dueDate === undefined ? existing.dueDate : patch.dueDate,
    categoryId: patch.categoryId === undefined ? existing.categoryId : patch.categoryId,
    sortOrder: patch.sortOrder ?? existing.sortOrder,
    completedAt,
  };

  const updated = repo.updateTodo(db, id, model);
  if (!updated) throw new NotFoundError(`待办 ${id} 不存在`);
  return updated;
}

export function deleteTodoById(id: number, db: SqliteDatabase = getDatabase()): void {
  if (!repo.deleteTodo(db, id)) throw new NotFoundError(`待办 ${id} 不存在`);
}

/** 按给定顺序写 sort_order；不存在的 id 忽略，返回重排后的完整列表。 */
export function reorderTodos(ids: readonly number[], db: SqliteDatabase = getDatabase()): Todo[] {
  ids.forEach((id, index) => {
    repo.updateSortOrder(db, id, (index + 1) * 10);
  });
  return repo.listAllTodos(db);
}
