import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // A zone far from UTC (UTC+13 in November) so any accidental UTC date
    // formatting shows up as an off-by-one-day failure.
    env: { TZ: "Pacific/Auckland" },
  },
});
