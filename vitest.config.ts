import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Load env file from the project root based on current mode
  // Passing an empty string as the third argument loads ALL variables
  // instead of just those prefixed with VITE_
  process.env = { ...process.env, ...loadEnv(mode, process.cwd(), "") };

  return {
    test: {
      // Your vitest configuration options here
      environment: "node",
    },
  };
});
