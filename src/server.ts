import {
  CoordinationV1Api,
  CoreV1Api,
  KubeConfig,
} from "@kubernetes/client-node";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { createLeaseService } from "./services/leaseService";
import { createPodService } from "./services/podService";

const podService = createPodService();

const leaseService = createLeaseService(podService);
await leaseService.init();

const app = express();

app.get("/health", async (_req: Request, res: Response) => {
  let kubernetesConnected = false;
  let healthyPodsCount = 0;

  try {
    const { totalHealthyCount } = await podService.getPods();
    healthyPodsCount = totalHealthyCount;
    kubernetesConnected = true;
  } catch (err) {
    console.error("Error fetching pods:", err);
  }

  return res.status(kubernetesConnected ? 200 : 503).json({
    ok: kubernetesConnected,
    kubernetes: kubernetesConnected ? "connected" : "disconnected",
    sandboxPodsReady: healthyPodsCount,
  });
});

app.get("/pods", async (_req: Request, res: Response) => {
  const kc = new KubeConfig();
  kc.loadFromDefault();

  const coordApi = kc.makeApiClient(CoordinationV1Api);
  const leases = await coordApi.listNamespacedLease({
    namespace: "default",
    labelSelector: "app=sandbox-runner",
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  return res.status(500).json({
    code: "INTERNAL_SERVER_ERROR",
    message:
      err instanceof Error ? err.message : "Something went wrong on our end.",
  });
});

export default app;
export { app };
