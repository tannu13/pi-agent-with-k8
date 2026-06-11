import { describe, it, expect } from "vitest";
import supertest from "supertest";
import app from "../server";

describe("GET /health - Live Cluster Integration", () => {
  it("should successfully connect to the live minikube API and find 8 ready pods", async () => {
    const response = await supertest(app).get("/health").expect(200);

    expect(response.body).toEqual({
      ok: true,
      kubernetes: "connected",
      sandboxPodsReady: 8,
    });
  }, 10000);
});
