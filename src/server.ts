import crypto from "node:crypto";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { logger } from "./logger";
import {
  createK8Service,
  SANDBOX_CAPACITY_TIMEOUT,
  type K8Service,
} from "./services/k8Service";
import { RealPiClient, type PiClient } from "./services/piClient";

type AppDeps = {
  k8Service?: K8Service;
  piClient?: PiClient;
};

export const getHealthPayload = async (k8Service: K8Service) => {
  const { totalHealthyCount } = await k8Service.getPods();

  return {
    ok: true,
    kubernetes: "connected",
    sandboxPodsReady: totalHealthyCount,
  };
};

export const getPodsPayload = async (k8Service: K8Service) => ({
  pods: await k8Service.getPoolState(),
});

export const createApp = (deps: AppDeps = {}) => {
  const k8Service = deps.k8Service ?? createK8Service();
  const piClient = deps.piClient ?? new RealPiClient(k8Service);
  const app = express();

  app.use(express.json());

  app.post("/chat", async (req: Request, res: Response, next: NextFunction) => {
    const requestId = crypto.randomUUID();

    if (!req.body?.message || typeof req.body.message !== "string") {
      return res.status(400).json({
        error: {
          code: "invalid_request",
          message: "Missing a string `message` in the payload.",
        },
      });
    }

    if (req.body.sessionId && typeof req.body.sessionId !== "string") {
      return res.status(400).json({
        error: {
          code: "invalid_request",
          message: "`sessionId` must be a string when provided.",
        },
      });
    }

    const sessionId = req.body.sessionId || crypto.randomUUID();

    logger.info("chat.request.started", {
      requestId,
      sessionId,
    });

    try {
      const result = await piClient.runChat({
        requestId,
        sessionId,
        message: req.body.message,
      });

      logger.info("chat.request.completed", {
        requestId,
        sessionId,
        toolCallCount: result.toolCalls.length,
        errorCode: result.error?.code,
      });

      if (result.error?.code === SANDBOX_CAPACITY_TIMEOUT) {
        return res.status(503).json({
          error: result.error,
        });
      }

      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get("/health", async (_req: Request, res: Response) => {
    try {
      return res.status(200).json(await getHealthPayload(k8Service));
    } catch (err) {
      logger.error("health.check_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(503).json({
        ok: false,
        kubernetes: "disconnected",
        sandboxPodsReady: 0,
      });
    }
  });

  app.get("/pods", async (_req: Request, res: Response) => {
    try {
      return res.status(200).json(await getPodsPayload(k8Service));
    } catch (err) {
      logger.error("pods.status_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({
        error: {
          code: "internal_server_error",
          message: "Failed to fetch sandbox pod status.",
        },
      });
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("http.unhandled_error", {
      error: err instanceof Error ? err.message : String(err),
    });

    return res.status(500).json({
      error: {
        code: "internal_server_error",
        message:
          err instanceof Error ? err.message : "Something went wrong on our end.",
      },
    });
  });

  return app;
};

const app = createApp();

export default app;
export { app };
