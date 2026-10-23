/** 管理员用户管理：创建、列出、停用/启用、重置密码。不读取任何用户内容数据。 */

import { Router } from 'express';
import { z } from 'zod';
import { getDatabase } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { requireAdmin } from '../../http/auth.js';
import { ForbiddenError } from '../../http/errors.js';
import { timezoneSchema } from '../../domain/schemas.js';
import {
  createUser,
  listUserSummaries,
  resetPassword,
  updateUser,
} from '../auth/service.js';
import { passwordSchema, usernameSchema } from '../auth/routes.js';

const createSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    displayName: z.string().trim().max(40).optional(),
    role: z.enum(['admin', 'user']).optional(),
    timezone: timezoneSchema.optional(),
  })
  .strict();

const updateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(40).optional(),
    role: z.enum(['admin', 'user']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

const passwordResetSchema = z.object({ password: passwordSchema }).strict();
const idParam = z.object({ id: z.coerce.number().int().positive() });

export function createUsersRouter(): Router {
  const router = Router();
  router.use(requireAdmin);

  router.get(
    '/',
    asyncHandler((_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ data: listUserSummaries(getDatabase()) });
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const input = createSchema.parse(req.body);
      const user = await createUser(getDatabase(), input);
      res.status(201).json({ data: user });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParam.parse(req.params);
      const input = updateSchema.parse(req.body);
      if (id === req.auth!.userId && input.status === 'disabled') {
        throw new ForbiddenError('不能停用当前登录的账号');
      }
      res.json({ data: updateUser(getDatabase(), id, input) });
    }),
  );

  router.post(
    '/:id/password',
    asyncHandler(async (req, res) => {
      const { id } = idParam.parse(req.params);
      const input = passwordResetSchema.parse(req.body);
      await resetPassword(getDatabase(), id, input.password);
      res.json({ data: { ok: true } });
    }),
  );

  return router;
}
