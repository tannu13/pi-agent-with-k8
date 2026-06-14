import { describe, expect, it } from "vitest";

import { getHealthPayload } from "../server";
import { createK8Service } from "../services/k8Service";
import { RealPiClient } from "../services/piClient";

describe("GET /health - Live Cluster Integration", () => {
  it("connects to the live local Kubernetes API and finds 8 ready pods", async () => {
    const response = await getHealthPayload(createK8Service());

    expect(response).toEqual({
      ok: true,
      kubernetes: "connected",
      sandboxPodsReady: 8,
    });
  }, 10000);
});

describe("Sandbox tool execution - Live Cluster Integration", () => {
  it("executes a command in a leased pod and releases the Lease", async () => {
    const service = createK8Service();
    await service.init();

    const output = await service.withSandboxLease(
      {
        requestId: "integration-req",
        sessionId: "integration-session",
        toolCallId: "integration-tool",
        toolName: "shell.run",
      },
      async (lease) => {
        const result = await service.execInPod(lease.podName, [
          "node",
          "--version",
        ]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/^v/);
        return { podName: lease.podName };
      },
    );

    const pool = await service.getPoolState();
    expect(pool.find((pod) => pod.name === output.podName)?.lease.status).toBe(
      "free",
    );
  }, 30000);

  it("handles 9 concurrent leased executions", async () => {
    const service = createK8Service();
    await service.init();

    const results = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        service.withSandboxLease(
          {
            requestId: `integration-req-${index}`,
            sessionId: "integration-session",
            toolCallId: `integration-tool-${index}`,
            toolName: "shell.run",
          },
          async (lease) => {
            const result = await service.execInPod(lease.podName, ["whoami"]);
            expect(result.exitCode).toBe(0);
            return lease.podName;
          },
        ),
      ),
    );

    expect(results).toHaveLength(9);
    expect(new Set(results).size).toBeLessThanOrEqual(8);
  }, 45000);
});

describe("Pi-backed chat - Live Cluster Integration", () => {
  it.runIf(process.env.GEMINI_API_KEY && process.env.RUN_PI_SMOKE === "1")(
    "triggers the sandbox tool execution path",
    async () => {
      const service = createK8Service();
      await service.init();
      const piClient = new RealPiClient(service);

      const result = await piClient.runChat({
        requestId: "pi-smoke-req",
        sessionId: "pi-smoke-session",
        message:
          "Use the env.inspect tool exactly once and tell me the pod name.",
      });

      expect(result.toolCalls.length).toBeGreaterThan(0);
      expect(result.toolCalls.some((toolCall) => toolCall.pod)).toBe(true);
    },
    120000,
  );
});
