import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import env from "./env";
import type { TPodsresponse } from "./types";
import { createK8Service } from "./services/k8Service";

const k8Service = createK8Service();
await k8Service.init();

const app = express();

app.get("/health", async (_req: Request, res: Response) => {
  try {
    const { totalHealthyCount } = await k8Service.getPods();

    return res.status(200).json({
      ok: true,
      kubernetes: "connected",
      sandboxPodsReady: totalHealthyCount,
    });
  } catch (err) {
    console.error("Health check failed:", err);
    return res.status(503).json({
      ok: false,
      kubernetes: "disconnected",
      sandboxPodsReady: 0,
    });
  }
});

app.get("/pods", async (_req: Request, res: Response) => {
  try {
    const [{ podsMap }, leases] = await Promise.all([
      k8Service.getPods(),
      k8Service.getLeases(),
    ]);

    const pods = Array.from({ length: 8 }, (_, i) => {
      const podName = `${env.K8_LABEL}-${i}`;

      const livePod = podsMap.get(podName);
      const lease = leases.find((l) => l.metadata?.name === podName);

      let leaseStatus: "free" | "leased" = "free";
      let holderIdentity: string | undefined = undefined;
      let expiresAt: string | undefined = undefined;

      if (lease?.spec) {
        const {
          holderIdentity: holder,
          renewTime,
          acquireTime,
          leaseDurationSeconds = env.LEASE_DURATION_SECONDS,
        } = lease.spec;

        const baseTime = renewTime || acquireTime;
        if (holder && baseTime) {
          const expirationMs =
            new Date(baseTime).getTime() + leaseDurationSeconds * 1000;

          console.log(new Date(baseTime).getTime(), Date.now(), expirationMs);

          if (Date.now() < expirationMs) {
            leaseStatus = "leased";
            holderIdentity = holder;
            expiresAt = new Date(expirationMs).toISOString();
          }
        }
      }

      return {
        name: podName,
        ready: livePod ? livePod.ready : false,
        lease: {
          status: leaseStatus,
          ...(leaseStatus === "leased" && { holderIdentity, expiresAt }),
        },
      };
    });

    return res.status(200).json({ pods });
  } catch (err) {
    console.error("Error generating pod statuses:", err);
    return res.status(500).json({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to fetch status.",
    });
  }
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
