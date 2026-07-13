import { HttpError } from "./http-error.js";

const filterSpecialPattern = /[%_,()]/g;

export const parseBody = (schema, payload) => {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new HttpError(400, "Invalid request body.", result.error.flatten());
  }
  return result.data;
};

export const parseQuery = (schema, payload) => {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new HttpError(400, "Invalid query parameters.", result.error.flatten());
  }
  return result.data;
};

export const sanitizeIlikeTerm = (value) => value.replace(filterSpecialPattern, "\\$&");
