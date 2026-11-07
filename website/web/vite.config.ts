import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/** 局域网模式：npm run dev:lan 会设置 VITE_LAN=1。 */
const lanMode = process.env.VITE_LAN === '1';

/**
 * 开发期通过代理把 /api 转发到后端，前端代码里因此不需要写死后端地址；
 * 部署时若前后端同进程，只需把 SERVE_STATIC 打开即可。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    // 默认只监听本机；npm run dev:lan 会设置 VITE_LAN=1，让手机/平板也能打开控制台。
    host: lanMode ? true : '127.0.0.1',
    // 局域网模式允许通过计算机名 / mDNS 名称访问，不再只认 IP 与 localhost。
    ...(lanMode ? { allowedHosts: true } : {}),
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4000',
        // 必须保留浏览器原始 Host：后端用「Origin 的 host 是否等于 Host」判断同源，
        // 改成 true 会把 Host 重写成 127.0.0.1:4000，局域网设备的登录/初始化写请求会被 403 拒绝。
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: [],
  },
});
