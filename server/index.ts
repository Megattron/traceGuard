import { loadConfig } from './config.ts';
import { createApp } from './app.ts';

const config = loadConfig();
const { server, scheduler } = createApp(config);
server.on('error', error => {
  console.error(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
    ? `端口 ${config.port} 已被占用，请修改 PORT 后重试。` : '服务启动失败。');
  process.exitCode = 1;
});
server.listen(config.port, config.host, () => {
  console.log(`TraceGuard: http://localhost:${config.port} · ${config.mode === 'clickhouse' ? 'ClickHouse 只读数据' : '本地演示数据'}`);
  if (config.schedule?.enabled) scheduler.start();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  scheduler.stop();
  server.close(() => { void scheduler.waitForIdle().then(() => process.exit(0)); });
  server.closeIdleConnections();
});
