/**
 * 待办接口的集成测试。
 *
 * 覆盖：CRUD 与默认值、done 切换 completedAt、今天/本周过滤、分页、
 * 批量排序（含忽略不存在的 id）以及各种校验失败的响应形状。
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { closeDatabase, openDatabase, setDatabaseForTesting } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrations.js';
import { addDaysToDateKey } from '../src/domain/time.js';
import { todayDateKey } from '../src/domain/display-time.js';

const TZ = 'Asia/Shanghai';

let app: Express;

function today(): string {
  return todayDateKey(TZ);
}

async function createTodo(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await request(app).post('/api/todos').send(body);
  expect(response.status).toBe(201);
  return response.body.data as Record<string, unknown>;
}

async function listTodos(
  query: Record<string, string | number | boolean> = {},
): Promise<{ data: Record<string, unknown>[]; meta: { total: number; limit: number; offset: number } }> {
  const response = await request(app).get('/api/todos').query(query);
  expect(response.status).toBe(200);
  return response.body as { data: Record<string, unknown>[]; meta: { total: number; limit: number; offset: number } };
}

beforeEach(() => {
  closeDatabase();
  const db = openDatabase(':memory:');
  runMigrations(db);
  setDatabaseForTesting(db);
  app = createApp();
});

afterAll(() => {
  closeDatabase();
  setDatabaseForTesting(null);
});

describe('待办增删改查', () => {
  it('创建时补齐默认值并返回 201', async () => {
    const todo = await createTodo({ title: '  买牛奶  ' });
    expect(todo).toMatchObject({
      title: '买牛奶',
      notes: '',
      done: false,
      priority: 'normal',
      dueDate: null,
      categoryId: null,
      sortOrder: 10,
      completedAt: null,
    });
    expect(todo.id).toBeGreaterThan(0);
    expect(new Date(todo.createdAt as string).toISOString()).toBe(todo.createdAt);
    expect(todo.updatedAt).toBe(todo.createdAt);
  });

  it('列表返回分页 meta，并支持 limit / offset', async () => {
    await createTodo({ title: 'A' });
    await createTodo({ title: 'B' });
    await createTodo({ title: 'C' });

    const all = await listTodos();
    expect(all.data).toHaveLength(3);
    expect(all.meta).toEqual({ total: 3, limit: 200, offset: 0 });

    const paged = await listTodos({ limit: 1, offset: 1 });
    expect(paged.data).toHaveLength(1);
    expect(paged.meta).toEqual({ total: 3, limit: 1, offset: 1 });
  });

  it('可以读取单条待办，不存在返回 404', async () => {
    const todo = await createTodo({ title: '写周报' });
    const response = await request(app).get(`/api/todos/${todo.id}`);
    expect(response.status).toBe(200);
    expect(response.body.data.title).toBe('写周报');

    const missing = await request(app).get('/api/todos/99999');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('PATCH 可以更新任意子集，done 切换会维护 completedAt', async () => {
    const todo = await createTodo({ title: '写周报', priority: 'low' });

    const updated = await request(app)
      .patch(`/api/todos/${todo.id}`)
      .send({ title: '写月报', notes: '先整理数据', priority: 'urgent', sortOrder: 5 });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({
      title: '写月报',
      notes: '先整理数据',
      priority: 'urgent',
      sortOrder: 5,
      done: false,
      completedAt: null,
    });

    const done = await request(app).patch(`/api/todos/${todo.id}`).send({ done: true });
    expect(done.status).toBe(200);
    expect(done.body.data.done).toBe(true);
    expect(done.body.data.completedAt).toBeTruthy();
    expect(new Date(done.body.data.completedAt as string).toISOString()).toBe(
      done.body.data.completedAt,
    );

    const undone = await request(app).patch(`/api/todos/${todo.id}`).send({ done: false });
    expect(undone.body.data.done).toBe(false);
    expect(undone.body.data.completedAt).toBeNull();
  });

  it('PATCH 拒绝 completedAt 字段与空请求体', async () => {
    const todo = await createTodo({ title: '待办' });

    const withCompletedAt = await request(app)
      .patch(`/api/todos/${todo.id}`)
      .send({ completedAt: new Date().toISOString() });
    expect(withCompletedAt.status).toBe(422);
    expect(withCompletedAt.body.error.code).toBe('VALIDATION_FAILED');

    const empty = await request(app).patch(`/api/todos/${todo.id}`).send({});
    expect(empty.status).toBe(422);
  });

  it('DELETE 返回 204，重复删除返回 404', async () => {
    const todo = await createTodo({ title: '待删除' });
    const removed = await request(app).delete(`/api/todos/${todo.id}`);
    expect(removed.status).toBe(204);
    expect(removed.text).toBe('');

    expect((await request(app).get(`/api/todos/${todo.id}`)).status).toBe(404);
    expect((await request(app).delete(`/api/todos/${todo.id}`)).status).toBe(404);
  });

  it('标题空白、超长与非法日期都返回 422', async () => {
    expect((await request(app).post('/api/todos').send({ title: '   ' })).status).toBe(422);
    expect((await request(app).post('/api/todos').send({ title: 'x'.repeat(201) })).status).toBe(422);
    expect(
      (await request(app).post('/api/todos').send({ title: '日期错误', dueDate: '2025-02-30' })).status,
    ).toBe(422);
    expect((await request(app).get('/api/todos').query({ due: 'month' })).status).toBe(422);
    expect((await request(app).get('/api/todos').query({ limit: 501 })).status).toBe(422);
  });

  it('引用不存在的分类返回 422，引用有效分类成功', async () => {
    const invalid = await request(app).post('/api/todos').send({ title: '分类错误', categoryId: 9999 });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.message).toContain('分类');

    const category = await request(app).post('/api/categories').send({ name: '工作', color: '#3b6fd4' });
    const created = await createTodo({ title: '分类正确', categoryId: category.body.data.id });
    expect(created.categoryId).toBe(category.body.data.id);
  });
});

describe('截止日期与完成状态过滤', () => {
  it('due=today 只返回今天到期，due=week 返回今天起 7 天（含当天）', async () => {
    const base = today();
    await createTodo({ title: '今天', dueDate: base });
    await createTodo({ title: '三天后', dueDate: addDaysToDateKey(base, 3) });
    await createTodo({ title: '第六天', dueDate: addDaysToDateKey(base, 6) });
    await createTodo({ title: '第七天', dueDate: addDaysToDateKey(base, 7) });
    await createTodo({ title: '没有截止' });

    const todayList = await listTodos({ due: 'today' });
    expect(todayList.data.map((todo) => todo.title)).toEqual(['今天']);
    expect(todayList.meta.total).toBe(1);

    const weekList = await listTodos({ due: 'week' });
    expect(weekList.data.map((todo) => todo.title).sort()).toEqual(['三天后', '今天', '第六天'].sort());
    expect(weekList.meta.total).toBe(3);
  });

  it('done 过滤与排序：未完成在前', async () => {
    const first = await createTodo({ title: '先建' });
    const second = await createTodo({ title: '后建' });
    await request(app).patch(`/api/todos/${first.id}`).send({ done: true });

    const pending = await listTodos({ done: false });
    expect(pending.data.map((todo) => todo.title)).toEqual(['后建']);

    const finished = await listTodos({ done: true });
    expect(finished.data.map((todo) => todo.title)).toEqual(['先建']);

    const all = await listTodos();
    expect(all.data.map((todo) => todo.title)).toEqual(['后建', '先建']);
    expect(second.id).toBeGreaterThan(0);
  });
});

describe('批量排序', () => {
  it('按 ids 顺序写入 sort_order 并返回完整列表', async () => {
    const a = await createTodo({ title: 'A' });
    const b = await createTodo({ title: 'B' });
    const c = await createTodo({ title: 'C' });

    const reordered = await request(app)
      .put('/api/todos/order')
      .send({ ids: [c.id, a.id, b.id] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.data.map((todo: { title: string }) => todo.title)).toEqual(['C', 'A', 'B']);
    expect(reordered.body.data.map((todo: { sortOrder: number }) => todo.sortOrder)).toEqual([10, 20, 30]);
  });

  it('忽略不存在的 id，其余顺序保持', async () => {
    const a = await createTodo({ title: 'A' });
    const b = await createTodo({ title: 'B' });
    const c = await createTodo({ title: 'C' });

    const reordered = await request(app)
      .put('/api/todos/order')
      .send({ ids: [b.id, 99999, a.id, c.id] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.data.map((todo: { title: string }) => todo.title)).toEqual(['B', 'A', 'C']);
  });

  it('ids 不是合法数字数组时返回 422', async () => {
    const response = await request(app).put('/api/todos/order').send({ ids: ['a', 'b'] });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });
});
