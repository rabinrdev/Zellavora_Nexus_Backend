import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 60000,
    hookTimeout: 120000,
    fileParallelism: false,
    globalSetup: ['tests/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://nexus_app:nexus_app_dev_pw@localhost:54329/nexus',
      MIGRATOR_DATABASE_URL: process.env.MIGRATOR_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/nexus',
      JWT_SECRET: 'test-jwt-secret-test-jwt-secret-1234',
      DATA_ENCRYPTION_KEY: '0f'.repeat(32),
      JOBS_DRIVER: 'inline',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/platform/**', 'src/modules/auth/**', 'src/modules/iam/**', 'src/modules/organizations/**', 'src/modules/audit/**'],
      exclude: ['src/**/*.test.ts', 'src/platform/types.ts'],
      thresholds: { lines: 80, statements: 80, functions: 75, branches: 65 },
    },
  },
});
