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
      // 初始化验证码：测试里固定验证码并强制要求，覆盖真实部署的默认分支
      INKPANE_SETUP_CODE: 'test-setup-code',
      SETUP_REQUIRE_CODE: 'true',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*-cli.ts', 'src/index.ts'],
    },
  },
});
