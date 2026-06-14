import {
  ApiException,
  CoordinationV1Api,
  CoreV1Api,
  Exec,
  KubeConfig,
  V1Lease,
  V1Pod,
  V1Status,
} from "@kubernetes/client-node";
import { Writable } from "node:stream";

import env from "../env";
import { logger } from "../logger";
import type { TPodInfo } from "../types";

export const SANDBOX_CAPACITY_TIMEOUT = "sandbox_capacity_timeout";

export class SandboxCapacityTimeoutError extends Error {
  code = SANDBOX_CAPACITY_TIMEOUT;

  constructor(maxWaitMs = env.QUEUE_MAX_WAIT_MS) {
    super(
      `No sandbox pod became available within ${Math.round(maxWaitMs / 1000)} seconds.`,
    );
    this.name = "SandboxCapacityTimeoutError";
  }
}

export type SandboxExecutionContext = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
};

export type SandboxLease = {
  podName: string;
  leaseName: string;
  holderIdentity: string;
};

export type PodExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type Waiter = () => void;

class BufferWritable extends Writable {
  private chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  override toString() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

class SandboxLeaseQueue {
  private queue: Array<{
    started: boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    context: SandboxExecutionContext;
  }> = [];

  private availabilityWaiters = new Set<Waiter>();

  async waitForTurn(context: SandboxExecutionContext, maxWaitMs: number) {
    logger.info("sandbox.queue.wait_started", {
      ...context,
      maxWaitMs,
    });

    await new Promise<void>((resolve, reject) => {
      const entry = {
        started: false,
        resolve,
        reject,
        context,
        timer: setTimeout(() => {
          if (entry.started) return;
          this.queue = this.queue.filter((queued) => queued !== entry);
          logger.warn("sandbox.queue.wait_timed_out", {
            ...context,
            maxWaitMs,
          });
          reject(new SandboxCapacityTimeoutError(maxWaitMs));
          this.processNext();
        }, maxWaitMs),
      };

      this.queue.push(entry);
      this.processNext();
    });

    logger.info("sandbox.queue.wait_completed", { ...context });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.queue.shift();
      this.processNext();
    };
  }

  waitForAvailability(ms: number) {
    return new Promise<void>((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        this.availabilityWaiters.delete(waiter);
        resolve();
      };

      const timer = setTimeout(waiter, ms);
      this.availabilityWaiters.add(waiter);
    });
  }

  notifyAvailability() {
    const waiters = Array.from(this.availabilityWaiters);
    this.availabilityWaiters.clear();
    for (const waiter of waiters) waiter();
  }

  private processNext() {
    const next = this.queue[0];
    if (!next || next.started) return;

    next.started = true;
    clearTimeout(next.timer);
    next.resolve();
  }
}

const getExpectedPodNames = () =>
  Array.from({ length: env.SANDBOX_COUNT }, (_, i) => `${env.K8_LABEL}-${i}`);

const holderIdentityFor = (context: SandboxExecutionContext) =>
  `${env.SERVICE_INSTANCE_ID}:${context.requestId}:${context.sessionId}:${context.toolCallId}`;

const toK8MicroTime = (date: Date) =>
  date.toISOString().replace(/(\.\d{3})Z$/, "$1000Z");

export const getLeaseExpiration = (lease: V1Lease) => {
  const leaseDurationSeconds =
    lease.spec?.leaseDurationSeconds ?? env.LEASE_DURATION_SECONDS;
  const baseTime = lease.spec?.renewTime ?? lease.spec?.acquireTime;
  if (!lease.spec?.holderIdentity || !baseTime) return undefined;

  const expirationMs =
    new Date(baseTime as unknown as string).getTime() +
    leaseDurationSeconds * 1000;

  if (Number.isNaN(expirationMs)) return undefined;
  return new Date(expirationMs);
};

export const getLeaseStatus = (lease: V1Lease | undefined, now = new Date()) => {
  const expiresAt = lease ? getLeaseExpiration(lease) : undefined;
  const holderIdentity = lease?.spec?.holderIdentity || undefined;

  if (holderIdentity && expiresAt && expiresAt.getTime() > now.getTime()) {
    return {
      status: "leased" as const,
      holderIdentity,
      expiresAt: expiresAt.toISOString(),
    };
  }

  return { status: "free" as const };
};

export const createK8Service = (deps?: {
  coordApi?: CoordinationV1Api;
  k8sApi?: CoreV1Api;
  exec?: Exec;
}) => {
  const kc = new KubeConfig();
  if (!deps?.coordApi || !deps?.k8sApi || !deps?.exec) {
    kc.loadFromDefault();
  }

  const coordApi = deps?.coordApi ?? kc.makeApiClient(CoordinationV1Api);
  const k8sApi = deps?.k8sApi ?? kc.makeApiClient(CoreV1Api);
  const execClient = deps?.exec ?? new Exec(kc);
  const queue = new SandboxLeaseQueue();

  const isPodReady = (pod: V1Pod): boolean => {
    if (pod.status?.phase !== "Running") return false;
    const conditions = pod.status.conditions || [];
    return conditions.some((c) => c.type === "Ready" && c.status === "True");
  };

  const init = async () => {
    for (const name of getExpectedPodNames()) {
      try {
        await coordApi.createNamespacedLease({
          namespace: env.K8_NAMESPACE,
          body: {
            apiVersion: "coordination.k8s.io/v1",
            kind: "Lease",
            metadata: {
              name,
              labels: {
                app: env.K8_LABEL,
              },
            },
            spec: {
              holderIdentity: "",
              leaseDurationSeconds: env.LEASE_DURATION_SECONDS,
            },
          },
        });
      } catch (err) {
        if (!(err instanceof ApiException && err.code === 409)) throw err;
      }
    }
  };

  const getLeases = async () => {
    const res = await coordApi.listNamespacedLease({
      namespace: env.K8_NAMESPACE,
      labelSelector: `app=${env.K8_LABEL}`,
    });
    return res.items;
  };

  const getPods = async () => {
    const res = await k8sApi.listNamespacedPod({
      namespace: env.K8_NAMESPACE,
      labelSelector: `app=${env.K8_LABEL}`,
    });

    const podsMap = new Map<string, TPodInfo>();
    let totalHealthyCount = 0;

    for (const pod of res.items) {
      const name = pod.metadata?.name;
      if (!name) continue;

      const ready = isPodReady(pod);
      if (ready) totalHealthyCount++;

      podsMap.set(name, { name, ready });
    }

    return { totalHealthyCount, podsMap };
  };

  const acquireLeaseOnce = async (
    context: SandboxExecutionContext,
  ): Promise<SandboxLease | undefined> => {
    const leases = await getLeases();
    const leasesByName = new Map(
      leases
        .filter((lease) => lease.metadata?.name)
        .map((lease) => [lease.metadata!.name!, lease]),
    );

    for (const podName of getExpectedPodNames()) {
      const listedLease = leasesByName.get(podName);
      if (getLeaseStatus(listedLease).status !== "free") continue;

      logger.info("sandbox.lease.acquire_attempted", {
        ...context,
        pod: podName,
      });

      try {
        const freshLease = await coordApi.readNamespacedLease({
          namespace: env.K8_NAMESPACE,
          name: podName,
        });

        if (getLeaseStatus(freshLease).status !== "free") continue;

        const now = new Date();
        const holderIdentity = holderIdentityFor(context);
        const updatedLease: V1Lease = {
          ...freshLease,
          spec: {
            ...freshLease.spec,
            holderIdentity,
            leaseDurationSeconds: env.LEASE_DURATION_SECONDS,
            acquireTime: toK8MicroTime(now) as any,
            renewTime: toK8MicroTime(now) as any,
          },
        };

        await coordApi.replaceNamespacedLease({
          namespace: env.K8_NAMESPACE,
          name: podName,
          body: updatedLease,
        });

        logger.info("sandbox.lease.acquired", {
          ...context,
          pod: podName,
          leaseDurationSeconds: env.LEASE_DURATION_SECONDS,
        });

        return {
          podName,
          leaseName: podName,
          holderIdentity,
        };
      } catch (err) {
        if (err instanceof ApiException && err.code === 409) {
          logger.info("sandbox.lease.conflict", {
            ...context,
            pod: podName,
          });
          continue;
        }

        if (err instanceof ApiException && err.code === 404) {
          continue;
        }

        throw err;
      }
    }

    return undefined;
  };

  const acquireLease = async (
    context: SandboxExecutionContext,
    maxWaitMs = env.QUEUE_MAX_WAIT_MS,
  ) => {
    const deadline = Date.now() + maxWaitMs;
    const releaseQueueTurn = await queue.waitForTurn(context, maxWaitMs);

    try {
      while (Date.now() < deadline) {
        const lease = await acquireLeaseOnce(context);
        if (lease) {
          releaseQueueTurn();
          return lease;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await queue.waitForAvailability(Math.min(remainingMs, 100));
      }

      logger.warn("sandbox.queue.wait_timed_out", {
        ...context,
        maxWaitMs,
      });
      throw new SandboxCapacityTimeoutError(maxWaitMs);
    } catch (err) {
      releaseQueueTurn();
      throw err;
    }
  };

  const releaseLease = async (lease: SandboxLease) => {
    try {
      const freshLease = await coordApi.readNamespacedLease({
        namespace: env.K8_NAMESPACE,
        name: lease.leaseName,
      });

      if (freshLease.spec?.holderIdentity !== lease.holderIdentity) {
        queue.notifyAvailability();
        return;
      }

      await coordApi.replaceNamespacedLease({
        namespace: env.K8_NAMESPACE,
        name: lease.leaseName,
        body: {
          ...freshLease,
          spec: {
            ...freshLease.spec,
            holderIdentity: "",
            acquireTime: undefined,
            renewTime: undefined,
            leaseTransitions: undefined,
          },
        },
      });

      logger.info("sandbox.lease.released", {
        pod: lease.podName,
        holderIdentity: lease.holderIdentity,
      });
    } finally {
      queue.notifyAvailability();
    }
  };

  const execInPod = async (
    podName: string,
    command: string[],
    timeoutMs = env.TOOL_TIMEOUT_MS,
  ): Promise<PodExecResult> => {
    const stdout = new BufferWritable();
    const stderr = new BufferWritable();

    let ws: Awaited<ReturnType<Exec["exec"]>> | undefined;
    let timeout: NodeJS.Timeout | undefined;

    return await new Promise<PodExecResult>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        fn();
      };

      timeout = setTimeout(() => {
        ws?.close();
        settle(() => reject(new Error("Tool execution timed out.")));
      }, timeoutMs);

      execClient
        .exec(
          env.K8_NAMESPACE,
          podName,
          env.K8_CONTAINER,
          command,
          stdout,
          stderr,
          null,
          false,
          (status: V1Status) => {
            const exitCode = Number(
              status.details?.causes?.find((cause) => cause.reason === "ExitCode")
                ?.message ?? (status.status === "Success" ? 0 : 1),
            );

            settle(() =>
              resolve({
                stdout: stdout.toString().trim(),
                stderr: stderr.toString().trim(),
                exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
              }),
            );
          },
        )
        .then((socket) => {
          ws = socket;
        })
        .catch((err) => settle(() => reject(err)));
    });
  };

  const withSandboxLease = async <T>(
    context: SandboxExecutionContext,
    fn: (lease: SandboxLease) => Promise<T>,
  ) => {
    const lease = await acquireLease(context);
    try {
      return await fn(lease);
    } finally {
      await releaseLease(lease);
    }
  };

  const getPoolState = async () => {
    const [{ podsMap }, leases] = await Promise.all([getPods(), getLeases()]);
    return getExpectedPodNames().map((podName) => {
      const livePod = podsMap.get(podName);
      const lease = leases.find((item) => item.metadata?.name === podName);
      return {
        name: podName,
        ready: livePod ? livePod.ready : false,
        lease: getLeaseStatus(lease),
      };
    });
  };

  return {
    init,
    getLeases,
    getPods,
    getPoolState,
    acquireLease,
    releaseLease,
    withSandboxLease,
    execInPod,
  };
};

export type K8Service = ReturnType<typeof createK8Service>;
