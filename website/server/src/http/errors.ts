/** 统一的领域错误类型，由全局错误中间件转换为标准 JSON 响应。 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR'
  | 'PAYLOAD_TOO_LARGE';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** 标记为 true 的错误才允许把 message 直接暴露给客户端 */
  readonly expose: boolean;

  constructor(
    message: string,
    status: number,
    code: ErrorCode,
    options: { details?: unknown; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.expose = options.expose ?? true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = '请求参数不合法', details?: unknown) {
    super(message, 400, 'BAD_REQUEST', { details });
  }
}

export class ValidationError extends AppError {
  constructor(message = '请求数据校验未通过', details?: unknown) {
    super(message, 422, 'VALIDATION_FAILED', { details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = '资源冲突', details?: unknown) {
    super(message, 409, 'CONFLICT', { details });
  }
}

export class InternalError extends AppError {
  constructor(message = '服务器内部错误', cause?: unknown) {
    super(message, 500, 'INTERNAL_ERROR', { expose: false, cause });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
