import pino from "pino";

import { env } from "./config.js";

export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "response.config.headers.Authorization",
      "*.apiKey",
      "*.token",
      "*.content",
    ],
    censor: "[REDACTED]",
  },
});
