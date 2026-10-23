/** 控制台设备管理：每台硬件一个令牌，完整令牌只在创建/轮换时返回一次。 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/async-handler.js';
import { requireUser } from '../../http/auth.js';
import {
  createDevice,
  getDevice,
  listDevices,
  removeDevice,
  renameDevice,
  rotateDeviceToken,
} from './service.js';

const nameSchema = z.string().trim().min(1, '设备名不能为空').max(40, '设备名最多 40 字');
const createSchema = z.object({ name: nameSchema }).strict();
const updateSchema = z.object({ name: nameSchema }).strict();
const idParam = z.object({ id: z.coerce.number().int().positive() });

export function createDevicesRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ data: listDevices(requireUser(req).userId) });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const input = createSchema.parse(req.body);
      const result = createDevice(requireUser(req).userId, input.name);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ data: result });
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParam.parse(req.params);
      res.json({ data: getDevice(requireUser(req).userId, id) });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParam.parse(req.params);
      const input = updateSchema.parse(req.body);
      res.json({ data: renameDevice(requireUser(req).userId, id, input.name) });
    }),
  );

  router.post(
    '/:id/rotate',
    asyncHandler((req, res) => {
      const { id } = idParam.parse(req.params);
      const result = rotateDeviceToken(requireUser(req).userId, id);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ data: result });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParam.parse(req.params);
      removeDevice(requireUser(req).userId, id);
      res.json({ data: { removed: true } });
    }),
  );

  return router;
}
