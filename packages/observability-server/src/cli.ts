/**
 * @aipack/observability-server/src/cli.ts — 收集服务启动入口（bin: observability-server）。
 *
 *   POST /api/v1/ingest           客户端埋点上报(appId+Secret 动态鉴权)→ SQLite 落盘 + 聚合
 *   POST /api/auth/login|logout   面板登录/登出
 *   GET  /api/auth/me             当前会话
 *   GET/POST/DELETE /api/apps*    应用管理(动态生成 appId/appSecret)
 *   GET  /metrics/*               聚合查询(summary / timeseries / tools，需登录)
 *   GET  /traces/*                Trace 明细查询(需登录)
 *   GET  /*                       面板静态文件(STATIC_DIR 配置时)
 *
 * 启动: pnpm --filter @aipack/observability-server dev
 * 客户端接入:
 *   const obs = createObservability({ appId: 'travel-app', appSecret: 'sk-xxx', endpoint: 'http://localhost:8787' });
 */
import { promises as fs } from 'node:fs';
import { createCollector, createCollectorServer } from './collector.js';
import { loadConfig } from './config.js';

function pad(s: string, n: number): string {
  let width = 0;
  for (const ch of s) width += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  const need = Math.max(0, n - width);
  return s + ' '.repeat(need);
}

async function main() {
  const config = loadConfig();
  const collector = createCollector({
    dbPath: config.dbPath,
    apps: config.seedApps,
    admin: config.admin,
    sessionSecret: config.sessionSecret,
    staticDir: config.staticDir,
    retention: config.retention,
    alerts: config.alerts,
    rateLimit: config.rateLimit,
    logStreamUrlTemplate: config.logStreamUrlTemplate,
  });

  // TLS_KEY / TLS_CERT 都配置时以 HTTPS 提供服务
  let tls;
  if (config.tls) {
    const [key, cert] = await Promise.all([
      fs.readFile(config.tls.keyPath),
      fs.readFile(config.tls.certPath),
    ]);
    tls = { key, cert };
  }
  const server = createCollectorServer(collector, tls);
  const scheme = tls ? 'https' : 'http';

  server.listen(config.port, () => {
    const banner = [
      '',
      '╔══════════════════════════════════════════════════╗',
      '║     📊  aipack Observability Server (S2)       ║',
      '╠══════════════════════════════════════════════════╣',
      `║  地址:     ${pad(`${scheme}://localhost:${config.port}`, 38)}║`,
      `║  面板:     ${pad(`${scheme}://localhost:${config.port}（admin: ${config.admin.username}）`, 38)}║`,
      `║  SQLite:   ${pad(config.dbPath, 38)}║`,
      `║  种子应用: ${pad(config.seedApps && Object.keys(config.seedApps).length ? Object.keys(config.seedApps).join(', ') : '（无，面板创建）', 38)}║`,
      '╠══════════════════════════════════════════════════╣',
      `║  POST /api/v1/ingest     埋点上报(需 appId+Secret)  ║`,
      `║  POST /api/auth/login    面板登录                   ║`,
      `║  GET/POST /api/apps      应用管理(生成 appId/Secret)║`,
      `║  GET  /metrics/summary   聚合摘要(groupBy=model|tool|session)║`,
      `║  GET  /metrics/timeseries 时间序列                 ║`,
      `║  GET  /metrics/tools     工具成功率排行             ║`,
      `║  GET  /metrics/prometheus Prometheus 抓取(无鉴权)  ║`,
      `║  GET  /traces            运行列表                   ║`,
      `║  GET  /traces/:traceId   Trace 明细                ║`,
      '╚══════════════════════════════════════════════════╝',
      '',
    ].join('\n');
    console.log(banner);
  });

  // 优雅退出
  const shutdown = async (sig: string) => {
    console.log(`\n[${sig}] 正在关闭...`);
    server.close();
    await collector.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
