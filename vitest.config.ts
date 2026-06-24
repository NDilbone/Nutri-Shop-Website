import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()], // makes '@/...' imports resolve in tests
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
