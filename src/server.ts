import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { PossiblePhases } from "./types";

const app = express();

app.get("/health", async (_req: Request, res: Response) => {
  const kc = new KubeConfig();
  kc.loadFromDefault();

  const k8sApi = kc.makeApiClient(CoreV1Api);

  let kubernetesConnected = false;
  let healthyPodsCount = 0;
  try {
    const pods = await k8sApi.listNamespacedPod({
      namespace: "default",
      labelSelector: "app=sandbox-runner",
    });
    kubernetesConnected = true;
    for (const pod of pods.items) {
      if (pod.status?.phase === PossiblePhases.enum.Running) {
        healthyPodsCount++;
      }
    }
  } catch (err) {
    console.error("Error fetching pods:", err);
  }

  return res.status(kubernetesConnected ? 200 : 503).json({
    ok: kubernetesConnected,
    kubernetes: kubernetesConnected ? "connected" : "disconnected",
    sandboxPodsReady: healthyPodsCount,
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
