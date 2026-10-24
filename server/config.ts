import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { AppError, SCENARIOS, type Scenario, type SourceMode } from './types.ts';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export interface Config {
  host: string;
  port: number;
  mode: SourceMode;
  tenantId: string;
  runId: string;
  sqlitePath: string;
  clickhouse: { url: string; database: string; user: string; password: string };
  llm?: { provider:'bailian'; baseUrl:string; model:string; apiKey:string };
  schedule?: { enabled: boolean; intervalMs: number };
}

export function loadConfig(): Config {
  const envFile = resolve(ROOT, '.env.local');
  if (existsSync(envFile)) loadEnvFile(envFile);
  const mode = process.env.DATA_SOURCE || 'clickhouse';
  if (mode !== 'demo' && mode !== 'clickhouse') throw new Error('DATA_SOURCE 必须是 demo 或 clickhouse');
  const host = process.env.HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('最小版本仅支持本机监听');
  const port = Number(process.env.PORT || 3040);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
  const database = process.env.CLICKHOUSE_DATABASE || 'da';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(database)) throw new Error('CLICKHOUSE_DATABASE 无效');
  const chHost = process.env.CLICKHOUSE_HOST || '';
  let url = '';
  if (chHost) {
    const parsed = new URL(chHost.includes('://') ? chHost : `http://${chHost}`);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('CLICKHOUSE_HOST 必须是 HTTP(S) 主机地址');
    }
    if (!parsed.port) parsed.port = process.env.CLICKHOUSE_PORT || '8123';
    url = parsed.origin;
  }
  if (mode === 'clickhouse' && !url) throw new Error('ClickHouse 模式需要 CLICKHOUSE_HOST');
  const sqlitePath = resolve(ROOT, process.env.SQLITE_PATH || `.runtime/traceguard.${mode}.sqlite`);
  mkdirSync(dirname(sqlitePath), { recursive: true });
  const intervalSeconds = Number(process.env.AUTO_DETECT_INTERVAL_SECONDS || 15);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 3600) throw new Error('AUTO_DETECT_INTERVAL_SECONDS 必须在 1～3600 之间');
  let llm: Config['llm'];
  if (process.env.LLM_API_KEY) {
    const workspace=process.env.LLM_WORKSPACE_ID || '', region=process.env.LLM_REGION || 'cn-beijing';
    const model=process.env.LLM_MODEL || 'deepseek-v4.1-flash-1017';
    if (!/^[a-zA-Z0-9-]{5,100}$/.test(workspace) || !['cn-beijing','ap-southeast-1','us-east-1','eu-central-1','ap-northeast-1'].includes(region) || !/^[a-zA-Z0-9_.-]{1,128}$/.test(model)) throw new Error('LLM 业务空间、地域或模型配置无效');
    llm={provider:'bailian',baseUrl:`https://${workspace}.${region}.maas.aliyuncs.com/compatible-mode/v1`,model,apiKey:process.env.LLM_API_KEY};
  }
  return {
    host, port, mode, sqlitePath, llm,
    tenantId: process.env.TENANT_ID || '980107c0ab',
    runId: process.env.RUN_ID || 'tg_980107c0ab_20261016_20261023_v1',
    clickhouse: { url, database, user: process.env.CLICKHOUSE_USER || 'default', password: process.env.CLICKHOUSE_PASSWORD || '' },
    schedule: { enabled: process.env.AUTO_DETECT === '1', intervalMs: intervalSeconds * 1000 },
  };
}

export function parseInput(body: unknown) {
  if (!body || typeof body !== 'object') throw new AppError(400, 'INVALID_INPUT', '请输入检测窗口');
  const input = body as Record<string, unknown>;
  if (!SCENARIOS.includes(String(input.scenario) as Scenario)) throw new AppError(400, 'INVALID_SCENARIO', '请选择支持的验证场景');
  const start = String(input.windowStart || '');
  // Parse an explicit Shanghai offset; never use the host operating system timezone.
  if (!/^2026-10-(?:1[6-9]|2[0-3])T\d{2}:\d{2}$/.test(start)) throw new AppError(400, 'INVALID_WINDOW', '请选择 2026-10-16 至 2026-10-23 的检测时间');
  const value = Date.parse(start + ':00+08:00');
  if (!Number.isFinite(value) || new Date(value + 8 * 3600000).toISOString().slice(0, 16) !== start) throw new AppError(400, 'INVALID_WINDOW', '检测时间无效');
  const end = value + 600000;
  if (end > Date.parse('2026-10-24T00:00:00+08:00')) throw new AppError(400, 'INVALID_WINDOW', '检测窗口超出验证数据范围');
  return {
    scenario: String(input.scenario) as Scenario,
    windowStart: start.replace('T', ' ') + ':00.000',
    windowEnd: new Date(end + 8 * 3600000).toISOString().slice(0, 23).replace('T', ' '),
  };
}
