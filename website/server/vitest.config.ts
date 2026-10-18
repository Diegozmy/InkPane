import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
    // 测试期间只保留 error 级日志，避免预期内的 4xx 警告刷屏
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*-cli.ts', 'src/index.ts'],
    },
  },
});
