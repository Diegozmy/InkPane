/**
 * 以局域网可访问的方式启动控制台：
 *   HOST=0.0.0.0   后端监听所有网卡，设备 / 手机才能连上
 *   VITE_LAN=1     前端 Vite 也监听所有网卡（见 web/vite.config.ts）
 *
 * 用法：npm run dev:lan / npm run start:lan
 */
import { spawn } from 'node:child_process';

const script = process.argv[2] ?? 'dev';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env, HOST: process.env.HOST || '0.0.0.0', VITE_LAN: '1' };

console.log(`[lan] npm run ${script}（HOST=${env.HOST}）`);
const child = spawn(npm, ['run', script], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
