/** 天气的 HTTP 路由。 */

import { Router } from 'express';
import { getDatabase } from '../../db/client.js';
import { asyncHandler } from '../../http/async-handler.js';
import { requireUser } from '../../http/auth.js';
import { weatherSearchQuerySchema, weatherSettingsUpdateSchema } from '../../domain/schemas.js';
import {
  clearWeatherCache,
  getWeatherSnapshot,
  refreshWeatherSnapshot,
  searchWeatherCities,
} from './service.js';
import { writeWeatherSettings, weatherSettingsView } from './settings.js';

export function createWeatherRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json({ data: await getWeatherSnapshot(requireUser(req).userId) });
    }),
  );

  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      res.json({ data: await refreshWeatherSnapshot(requireUser(req).userId) });
    }),
  );

  router.get(
    '/settings',
    asyncHandler((req, res) => {
      res.json({ data: weatherSettingsView(getDatabase(), requireUser(req).userId) });
    }),
  );

  router.put(
    '/settings',
    asyncHandler((req, res) => {
      const patch = weatherSettingsUpdateSchema.parse(req.body);
      const db = getDatabase();
      const userId = requireUser(req).userId;
      writeWeatherSettings(db, userId, patch);
      // 城市/坐标/开关变化后旧缓存已无意义，清空以便下次刷新
      clearWeatherCache(db, userId);
      res.json({ data: weatherSettingsView(db, userId) });
    }),
  );

  router.get(
    '/search',
    asyncHandler(async (req, res) => {
      const { q } = weatherSearchQuerySchema.parse(req.query);
      const outcome = await searchWeatherCities(q);
      if (outcome.warning) {
        res.json({ data: { results: outcome.results }, meta: { warning: outcome.warning } });
        return;
      }
      res.json({ data: { results: outcome.results } });
    }),
  );

  return router;
}
