import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { AppError, isAppError } from './errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      startedAt: number;
    }
  }
}

/** 为每个请求分配 requestId，并记录起始时间。 */
export const requestContext: RequestHandler = (req, res, next) => {
  const headerValue = req.header('x-request-id');
  req.requestId = headerValue && headerValue.length <= 128 ? headerValue : randomUUID();
  req.startedAt = Date.now();
  // 回写响应头，便于前端报错时把 requestId 一起带上，快速定位服务端日志
  res.setHeader('X-Request-Id', req.requestId);
  next();
};

/** 只记录写操作与慢请求，避免高频轮询刷屏。 */
export const accessLog: RequestHandler = (req, res, next) => {
  res.on('finish', () => {
    const durationMs = Date.now() - req.startedAt;
    const isWrite = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
    const isNoisy = req.path.startsWith('/api/health');
    if (isNoisy && res.statusCode < 400) return;
    if (!isWrite && durationMs < 750 && res.statusCode < 400) return;

    const fields = {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs,
    };
    if (res.statusCode >= 500) logger.error('请求处理失败', undefined, fields);
    else if (res.statusCode >= 400) logger.warn('请求被拒绝', fields);
    else logger.info('请求完成', fields);
  });
  next();
};

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `接口不存在：${req.method} ${req.path}`,
      requestId: req.requestId,
    },
  });
};

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  void _next;

  if (res.headersSent) {
    logger.warn('响应已发出，无法再写入错误体', { requestId: req.requestId });
    res.end();
    return;
  }

  const body: ErrorBody = {
    error: {
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误',
      requestId: req.requestId,
    },
  };
  let status = 500;

  if (error instanceof ZodError) {
    status = 422;
    body.error.code = 'VALIDATION_FAILED';
    body.error.message = '请求数据校验未通过';
    body.error.details = error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
  } else if (isAppError(error)) {
    status = error.status;
    body.error.code = error.code;
    body.error.message = error.expose ? error.message : '服务器内部错误';
    if (error.details !== undefined) body.error.details = error.details;
  } else if (error instanceof SyntaxError && 'body' in error) {
    status = 400;
    body.error.code = 'BAD_REQUEST';
    body.error.message = '请求体不是合法的 JSON';
  } else if (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    (error as { type?: string }).type === 'entity.too.large'
  ) {
    status = 413;
    body.error.code = 'PAYLOAD_TOO_LARGE';
    body.error.message = '请求体超出大小限制';
  }

  const fields = {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl,
    status,
    code: body.error.code,
  };
  if (status >= 500) logger.error('未处理的服务端异常', error, fields);
  else logger.warn('请求返回错误', { ...fields, message: body.error.message });

  res.status(status).json(body);
};

/** 覆盖 CORS 预检与静态资源都通过后的兜底安全响应头（补充 helmet 未覆盖部分）。 */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!config.isProduction) res.setHeader('Cache-Control', 'no-store');
  next();
};

export function requireAppError(error: unknown): AppError | null {
  return isAppError(error) ? error : null;
}
