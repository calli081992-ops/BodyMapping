import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";

import { env } from "./config.js";
import { isHttpError } from "./lib/http-error.js";
import { logger } from "./logger.js";
import apiRouter from "./routes/api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");

const app = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
          id: request.id,
        };
      },
      res(response) {
        return {
          statusCode: response.statusCode,
        };
      },
    },
  }),
);

app.use(
  helmet({
    contentSecurityPolicy: false,
  }),
);

app.use(
  cors({
    origin: env.CORS_ORIGIN ? [env.CORS_ORIGIN] : true,
    methods: ["GET", "POST", "OPTIONS"],
  }),
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    environment: env.NODE_ENV,
  });
});

app.use("/api", apiRouter);
app.use(express.static(publicDir));
app.get("/", (_req, res) => {
  res.sendFile(path.resolve(publicDir, "index.html"));
});

app.use((error, _req, res, _next) => {
  if (isHttpError(error)) {
    return res.status(error.statusCode).json({
      error: error.message,
      details: error.details,
    });
  }

  if (error?.name === "ZodError") {
    return res.status(400).json({
      error: "Invalid request data.",
      details: error.flatten?.() ?? undefined,
    });
  }

  if (typeof error?.code === "string" && typeof error?.message === "string") {
    const statusCode = error.code === "PGRST116" ? 404 : 400;
    return res.status(statusCode).json({
      error: error.code === "PGRST116" ? "Record not found." : "Database request failed.",
      code: error.code,
    });
  }

  logger.error({ err: error }, "Unhandled request error");
  return res.status(500).json({
    error: "Internal server error.",
  });
});

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "HIPAA SOAP notes API listening");
});
