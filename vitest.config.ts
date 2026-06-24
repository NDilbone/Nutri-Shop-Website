import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

export default defineConfig({
  plugins: [tsconfigPaths()], // makes '@/...' imports resolve in tests
  resolve: {
    alias: {
      // server-only throws in non-Next.js runtimes; replace with a no-op for tests
      "server-only": path.resolve(
        __dirname,
        "tests/__mocks__/server-only.ts",
      ),
    },
  },
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
});
