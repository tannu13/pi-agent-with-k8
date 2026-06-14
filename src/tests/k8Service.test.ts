import { ApiException, type V1Lease } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

import { getPodsPayload } from "../server";
import {
  createK8Service,
  SandboxCapacityTimeoutError,
  type SandboxExecutionContext,
} from "../services/k8Service";

const podNames = Array.from({ length: 8 }, (_, i) => `sandbox-runner-${i}`);

const context = (toolCallId: string): SandboxExecutionContext => ({
  requestId: `req-${toolCallId}`,
  sessionId: "session-1",
  toolCallId,
  toolName: "shell.run",
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

class FakeCoordApi {
  leases = new Map<string, V1Lease>();
  version = 1;

  constructor(initialLeases: V1Lease[] = []) {
    for (const lease of initialLeases) {
      const name = lease.metadata?.name;
      if (name) this.leases.set(name, clone(lease));
    }
  }

  async createNamespacedLease({ body }: { body: V1Lease }) {
    const name = body.metadata?.name;
    if (!name) throw new Error("Lease name is required.");
    if (this.leases.has(name)) {
      throw new ApiException(409, "Conflict", {}, {});
    }

    const lease = clone(body);
    lease.metadata = {
      ...lease.metadata,
      resourceVersion: `${this.version++}`,
    };
    this.leases.set(name, lease);
    return clone(lease);
  }

  async listNamespacedLease() {
    return { items: Array.from(this.leases.values()).map(clone) };
  }

  async readNamespacedLease({ name }: { name: string }) {
    const lease = this.leases.get(name);
    if (!lease) throw new ApiException(404, "Not found", {}, {});
    return clone(lease);
  }

  async replaceNamespacedLease({
    name,
    body,
  }: {
    name: string;
    body: V1Lease;
  }) {
    const current = this.leases.get(name);
    if (!current) throw new ApiException(404, "Not found", {}, {});
    if (current.metadata?.resourceVersion !== body.metadata?.resourceVersion) {
      throw new ApiException(409, "Conflict", {}, {});
    }

    const updated = clone(body);
    updated.metadata = {
      ...updated.metadata,
      resourceVersion: `${this.version++}`,
    };
    this.leases.set(name, updated);
    return clone(updated);
  }
}

class FakeCoreApi {
  async listNamespacedPod() {
    return {
      items: podNames.map((name) => ({
        metadata: { name },
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
        },
      })),
    };
  }
}

const createFreeLeases = (): V1Lease[] =>
  podNames.map((name, index) => ({
    metadata: {
      name,
      labels: { app: "sandbox-runner" },
      resourceVersion: `${index + 1}`,
    },
    spec: {
      holderIdentity: "",
      leaseDurationSeconds: 45,
    },
  }));

const createFakeService = (leases = createFreeLeases()) =>
  createK8Service({
    coordApi: new FakeCoordApi(leases) as any,
    k8sApi: new FakeCoreApi() as any,
    exec: {
      exec: async () => ({ close: () => undefined }),
    } as any,
  });

describe("Kubernetes sandbox Lease manager", () => {
  it("acquires a free pod", async () => {
    const service = createFakeService();

    const lease = await service.acquireLease(context("tool-1"), 100);

    expect(lease.podName).toBe("sandbox-runner-0");
    expect(lease.holderIdentity).toContain("req-tool-1:session-1:tool-1");
  });

  it("releases a pod after successful tool execution", async () => {
    const service = createFakeService();

    await service.withSandboxLease(context("tool-1"), async (lease) => {
      expect(lease.podName).toBe("sandbox-runner-0");
    });

    const pool = await service.getPoolState();
    expect(pool[0]?.lease.status).toBe("free");
  });

  it("releases a pod after tool failure", async () => {
    const service = createFakeService();

    await expect(
      service.withSandboxLease(context("tool-1"), async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const pool = await service.getPoolState();
    expect(pool[0]?.lease.status).toBe("free");
  });

  it("releases a pod after timeout-style failures", async () => {
    const service = createFakeService();

    await expect(
      service.withSandboxLease(context("tool-1"), async () => {
        throw new Error("Tool execution timed out.");
      }),
    ).rejects.toThrow("timed out");

    const pool = await service.getPoolState();
    expect(pool[0]?.lease.status).toBe("free");
  });

  it("does not hand the same pod to concurrent acquisitions", async () => {
    const service = createFakeService();

    const leases = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        service.acquireLease(context(`tool-${i}`), 100),
      ),
    );

    expect(new Set(leases.map((lease) => lease.podName)).size).toBe(8);
  });

  it("runs a queued call when a pod becomes free", async () => {
    const service = createFakeService();
    const held = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        service.acquireLease(context(`held-${i}`), 100),
      ),
    );

    const queued = service.acquireLease(context("queued"), 500);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await service.releaseLease(held[0]!);

    await expect(queued).resolves.toMatchObject({
      podName: held[0]!.podName,
    });
  });

  it("fails a queued call after the max wait time", async () => {
    const service = createFakeService();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        service.acquireLease(context(`held-${i}`), 100),
      ),
    );

    await expect(service.acquireLease(context("queued"), 25)).rejects.toBeInstanceOf(
      SandboxCapacityTimeoutError,
    );
  });

  it("recovers an expired Lease", async () => {
    const leases = createFreeLeases();
    leases[0] = {
      ...leases[0]!,
      spec: {
        holderIdentity: "old-owner",
        leaseDurationSeconds: 1,
        renewTime: new Date("2000-01-01T00:00:00.000Z"),
      },
    };
    const service = createFakeService(leases);

    const lease = await service.acquireLease(context("tool-1"), 100);

    expect(lease.podName).toBe("sandbox-runner-0");
    expect(lease.holderIdentity).toContain("tool-1");
  });

  it("reports /pods with leased, free, expired, and missing states", async () => {
    const leases = createFreeLeases();
    leases[0] = {
      ...leases[0]!,
      spec: {
        holderIdentity: "api-1:req:session:tool",
        leaseDurationSeconds: 45,
        renewTime: new Date(),
      },
    };
    leases[1] = {
      ...leases[1]!,
      spec: {
        holderIdentity: "old-owner",
        leaseDurationSeconds: 1,
        renewTime: new Date("2000-01-01T00:00:00.000Z"),
      },
    };

    const k8Service = createFakeService(leases.slice(0, 7));
    const response = await getPodsPayload(k8Service);

    expect(response.pods[0]?.lease.status).toBe("leased");
    expect(response.pods[1]?.lease.status).toBe("free");
    expect(response.pods[7]?.lease.status).toBe("free");
  });
});
