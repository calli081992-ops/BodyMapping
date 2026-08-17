export class HttpError extends Error {
  constructor(statusCode, message, details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const isHttpError = (value) =>
  value instanceof HttpError && Number.isInteger(value.statusCode);
