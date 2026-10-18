import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * 包装 async 路由处理器，把 Promise 拒绝统一转交给 Express 错误中间件。
 * Express 4 不会自动捕获 async 抛出的异常，因此需要显式桥接。
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
