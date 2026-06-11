import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { CoreV1Api } from "@kubernetes/client-node";
import app from "../server";

describe("GET /health - Unit Tests (Mocked)", () => {
  // Create a handle to spy on the prototype method directly
  let listNamespacedPodSpy: any;

  beforeEach(() => {
    // Spy on the method belonging to the class prototype
    listNamespacedPodSpy = vi.spyOn(CoreV1Api.prototype, "listNamespacedPod");
  });

  afterEach(() => {
    // Restore the real implementation after every test block
    vi.restoreAllMocks();
  });

  it("should return 200 and show 8 ready pods when cluster is fully healthy", async () => {
    const mockPods = Array.from({ length: 8 }).map((_, i) => ({
      metadata: { name: `sandbox-runner-${i}` },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
      },
    }));

    // Mock a successful API response
    listNamespacedPodSpy.mockResolvedValue({
      items: mockPods,
    });

    const response = await supertest(app).get("/health").expect(200);

    expect(response.body).toEqual({
      ok: true,
      kubernetes: "connected",
      sandboxPodsReady: 8,
    });
  });

  it("should return 503 when the Kubernetes API server throws an error", async () => {
    // Mock an API crash
    listNamespacedPodSpy.mockRejectedValue(new Error("Connection refused"));

    const response = await supertest(app).get("/health").expect(503);

    expect(response.body).toEqual({
      ok: false,
      kubernetes: "disconnected",
      sandboxPodsReady: 0,
    });
  });
});
