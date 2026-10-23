/** 待办的 HTTP 路由：只做参数解析与响应序列化。 */

import { Router } from 'express';
import { asyncHandler } from '../../http/async-handler.js';
import { requireUser } from '../../http/auth.js';
import {
  idParamSchema,
  todoCreateSchema,
  todoListQuerySchema,
  todoOrderSchema,
  todoUpdateSchema,
} from '../../domain/schemas.js';
import {
  createTodo,
  deleteTodoById,
  getTodoOrThrow,
  listTodoItems,
  reorderTodos,
  updateTodoById,
} from './service.js';

export function createTodosRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      const query = todoListQuerySchema.parse(req.query);
      const result = listTodoItems(query, requireUser(req).userId);
      res.json({
        data: result.items,
        meta: { total: result.total, limit: result.limit, offset: result.offset },
      });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const input = todoCreateSchema.parse(req.body);
      res.status(201).json({ data: createTodo(input, requireUser(req).userId) });
    }),
  );

  // 批量排序必须放在 /:id 之前注册，避免被参数路由吃掉
  router.put(
    '/order',
    asyncHandler((req, res) => {
      const { ids } = todoOrderSchema.parse(req.body);
      res.json({ data: reorderTodos(ids, requireUser(req).userId) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      res.json({ data: getTodoOrThrow(id, requireUser(req).userId) });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = todoUpdateSchema.parse(req.body);
      res.json({ data: updateTodoById(id, patch, requireUser(req).userId) });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      deleteTodoById(id, requireUser(req).userId);
      res.status(204).end();
    }),
  );

  return router;
}
