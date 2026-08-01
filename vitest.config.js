import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    server: {
      deps: {
        inline: [/dashboard\//]
      }
    },
    coverage: {
      // Server-side code only — the code the suite imports directly, where a
      // percentage means something. dashboard/public/* is deliberately out:
      // those modules are exercised by evaluating them inside a jsdom window,
      // which v8 coverage cannot attribute back to the source file, so they
      // reported ~2% while being some of the most heavily pinned code in the
      // repo and dragged the total to 33%.
      include: ['dashboard/lib/**', 'dashboard/routes/**', 'dashboard/server.js'],

      // Floors, not targets. Measured over 4 runs on 2026-08-01:
      //   statements 87.09-87.50, branches 91.26-91.33,
      //   functions  78.85-80.82, lines    87.09-87.50
      // Each floor sits below the LOWEST of those, because the numbers are not
      // stable run to run: a handful of callbacks in small files (channelStrip,
      // history, videoQueue) execute or not depending on async timing, and with
      // few functions in those files the aggregate swings ~2 points. Functions
      // therefore gets the widest margin. Raise these when coverage genuinely
      // rises; do not lower them to make a red run green.
      thresholds: {
        statements: 86,
        branches: 90,
        functions: 77,
        lines: 86
      }
    }
  },
});
