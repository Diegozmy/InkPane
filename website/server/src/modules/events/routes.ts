/** 事件与日程实例的 HTTP 路由。 */

import { Router } from 'express';
import { asyncHandler } from '../../http/async-handler.js';
import {
  cancelOccurrenceSchema,
  eventCreateSchema,
  eventUpdateSchema,
  idParamSchema,
  listEventsQuerySchema,
  moveOccurrenceSchema,
  occurrenceQuerySchema,
  overrideSchema,
} from '../../domain/schemas.js';
import {
  browseEvents,
  cancelOccurrence,
  createEvent,
  deleteEvent,
  getEvent,
  listEventOverrides,
  moveOccurrence,
  queryOccurrences,
  resetOccurrenceOverride,
  updateEvent,
  upsertOccurrenceOverride,
} from './service.js';

export function createEventsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      const query = listEventsQuerySchema.parse(req.query);
      const result = browseEvents(query);
      res.json({
        data: result.items,
        meta: { total: result.total, limit: result.limit, offset: result.offset },
      });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const input = eventCreateSchema.parse(req.body);
      res.status(201).json({ data: createEvent(input) });
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      res.json({ data: getEvent(id) });
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      const patch = eventUpdateSchema.parse(req.body);
      res.json({ data: updateEvent(id, patch) });
    }),
  );

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      deleteEvent(id);
      res.status(204).end();
    }),
  );

  router.get(
    '/:id/overrides',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      res.json({ data: listEventOverrides(id) });
    }),
  );

  router.post(
    '/:id/move',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      const input = moveOccurrenceSchema.parse(req.body);
      const result = moveOccurrence(id, input);
      res.json({
        data: {
          scope: result.scope,
          event: result.event,
          createdEventId: result.createdEventId,
          override: result.override,
        },
      });
    }),
  );

  router.post(
    '/:id/cancel-occurrence',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      const input = cancelOccurrenceSchema.parse(req.body);
      const result = cancelOccurrence(id, input);
      res.json({
        data: {
          scope: result.scope,
          event: result.event,
          deleted: result.deleted,
          override: result.override,
        },
      });
    }),
  );

  router.put(
    '/:id/override',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      const input = overrideSchema.parse(req.body);
      res.json({ data: upsertOccurrenceOverride(id, input) });
    }),
  );

  router.delete(
    '/:id/override/:occurrenceKey',
    asyncHandler((req, res) => {
      const { id } = idParamSchema.parse(req.params);
      const occurrenceKey = String(req.params['occurrenceKey'] ?? '');
      res.json({ data: { removed: resetOccurrenceOverride(id, occurrenceKey) } });
    }),
  );

  return router;
}

/** 展开后的日程实例，供日历视图与搜索使用。 */
export function createOccurrencesRouter(): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      const query = occurrenceQuerySchema.parse(req.query);
      const result = queryOccurrences(query);
      res.json({
        data: result.items,
        meta: {
          range: result.range,
          timezone: result.timezone,
          count: result.items.length,
          truncated: result.truncated,
        },
      });
    }),
  );

  return router;
}
