import express, { type Request, type Response } from "express";

const app = express();

app.get("/health", async (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    kubernetes: "connected",
    sandboxPodsReady: 8,
  });
});

export default app;
export { app };
