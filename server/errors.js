export class HttpError extends Error {
  constructor(status, code, message, hint = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

export function errorPayload(error) {
  return {
    error: {
      code: error.code ?? 'INTERNAL',
      message: error.message ?? '服务器内部错误',
      hint: error.hint ?? null,
    },
  };
}
