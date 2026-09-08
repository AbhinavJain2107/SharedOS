import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/src/**/*.test.ts"],
    // The conformance suite runs every row against every column, and every cell
    // runs at least one whole turn against a seventeen-tool catalogue. A turn no
    // longer re-resolves that catalogue per call -- it holds one (ADR 0026) --
    // but a whole-suite test still does not fit in the 5s default.
    testTimeout: 120_000,
  },
});
