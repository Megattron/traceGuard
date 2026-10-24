import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ROOT, parseInput, type Config } from './config.ts';
import { Store, digest } from './store.ts';
import { FeatureSource, SQL_HASH } from './source.ts';
import { RULE, RULE_VERSION } from './rule.ts';
import { CATALOG, definition, evaluateConfigured, validateConfiguration } from './rules.ts';
import { AppError, type DetectionRun } from './types.ts';
import { applyBusinessPolicy } from './business-policy.ts';
import { DemoScheduler } from './scheduler.ts';
import { canonicalJSON, sha256 } from './reports.ts';
import { ModelClient, PROMPT_VERSION } from './model.ts';

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'JSON_REQUIRED', '请求需要使用 JSON 格式');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 32768) throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过大');
    chunks.push(bytes);
  }
  const content = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(content); } catch { throw new AppError(400, 'INVALID_JSON', 'JSON 格式无效'); }
}

export function createApp(config: Config) {
  const store = new Store(config.sqlitePath, config.tenantId);
  const source = new FeatureSource(config);
  const model = new ModelClient(config.llm);
  let busy = false;
  async function detect(body: unknown) {
    const input = parseInput(body);
    // Freeze every selected configuration before any asynchronous extraction.
    const configurations = store.configurations().filter(c => c.enabled);
    if (!configurations.length) throw new AppError(400, 'NO_ENABLED_RULES', '请先在规则配置中启用至少一条规则');
    const businessPolicy = store.businessPolicy(config.tenantId);
    const id = 'run_' + digest([config.mode, config.runId, config.tenantId, input, configurations, businessPolicy, SQL_HASH]).slice(0, 24);
    const cached = store.getRun(id);
    if (cached?.status === 'SUCCEEDED') return { run: cached, reused: true };
    if (busy) throw new AppError(409, 'DETECTION_BUSY', '已有检测正在进行，请稍后重试');
    busy = true;
    const at = performance.now();
    const run: DetectionRun = {
      id, dataBatchId:config.runId, businessPolicy:structuredClone(businessPolicy), sourceMode: config.mode, ...input, configurations, ruleVersion: configurations.map(c => c.version).join(' · '),
      status: 'RUNNING', startedAt: new Date().toISOString(), completedAt: null,
      elapsedMs: null, features: [], alertCount: 0, error: null,
    };
    try {
      store.saveRun(run);
      const extracted = await source.extract(input, configurations);
      const features = extracted.map(feature => applyBusinessPolicy(feature, businessPolicy, input.windowStart));
      const completed = store.completeRun(run, features, config.tenantId, SQL_HASH, Math.round(performance.now() - at));
      return { run: completed, reused: false };
    } catch (error) {
      store.failRun(run, error instanceof AppError ? error.message : '本次检测执行失败，可重新运行同一窗口。');
      throw error;
    } finally { busy = false; }
  }
  const scheduler = new DemoScheduler(async input => {
    const result = await detect(input);
    return { reused: result.reused, alertCount: result.run.alertCount };
  }, config.schedule?.intervalMs ?? 15000);
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ data, requestId }));
    };
    try {
      const authority = req.headers.host || '';
      let host: URL;
      try { host = new URL('http://' + authority); } catch { throw new AppError(403, 'INVALID_HOST', '本服务仅允许本机访问'); }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) throw new AppError(403, 'INVALID_HOST', '本服务仅允许本机访问');
      if (req.headers.origin && req.headers.origin !== host.origin) throw new AppError(403, 'INVALID_ORIGIN', '请求来源不被允许');
      const url = new URL(req.url || '/', host.origin);
      if (req.method === 'GET' && url.pathname === '/api/health') {
        json({ status: 'ok', sourceMode: config.mode, tenantId: config.tenantId, runId: config.runId, busy, ruleVersion: RULE_VERSION,
          enabledRules: store.configurations().filter(c => c.enabled).map(c => ({ id: c.id, version: c.version })) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/scheduler') {
        json({ enabled: config.schedule?.enabled ?? false, ...scheduler.status() }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/rule') { json(RULE); return; }
      if (req.method === 'GET' && url.pathname === '/api/business-policy') { json(store.businessPolicy(config.tenantId)); return; }
      if (req.method === 'GET' && url.pathname === '/api/rules') {
        json(CATALOG.map(def => ({ ...def, configuration: def.supported ? store.configuration(def.id) : null }))); return;
      }
      if (req.method==='GET' && url.pathname==='/api/reports') { json(store.reports()); return; }
      if (req.method==='GET' && url.pathname==='/api/reports/candidates') { json(store.reportCandidates()); return; }
      if (req.method==='GET' && url.pathname==='/api/reports/config') { json(model.info()); return; }
      if (req.method==='POST' && url.pathname==='/api/reports') { json(store.createReport(await readJson(req))); return; }
      const modelReviewRoute=url.pathname.match(/^\/api\/reports\/(FR-[A-F0-9]{12})\/analyses\/(AI-[a-f0-9-]{36})\/review$/);
      if(req.method==='POST'&&modelReviewRoute) { json(store.reviewAnalysis(modelReviewRoute[1],modelReviewRoute[2],await readJson(req)));return; }
      const reportRoute=url.pathname.match(/^\/api\/reports\/(FR-[A-F0-9]{12})(?:\/(verify|evidence|llm-context|archive|analyze|analyses))?$/);
      if (reportRoute) {
        const [,id,action]=reportRoute;
        if (req.method==='POST' && action==='archive') { json(store.archiveReport(id,await readJson(req))); return; }
        if(req.method==='POST'&&action==='analyze') {
          const body=await readJson(req), report=store.getReport(id);
          if(!config.llm)throw new AppError(503,'LLM_NOT_CONFIGURED','尚未配置模型服务，可以先使用规则报告');
          const input=model.prepare(report.payload);
          const {task,reused}=store.startAnalysis(id,body,{model:config.llm.model,promptVersion:PROMPT_VERSION,input,inputHash:sha256(canonicalJSON(input))});
          if(!reused) {
            try { const result=await model.analyze(report.payload);store.finishAnalysis({...task,...result,status:'SUCCEEDED',completedAt:new Date().toISOString()}); }
            catch(error) { store.finishAnalysis({...task,status:'FAILED',completedAt:new Date().toISOString(),error:error instanceof AppError?error.message:'模型调用失败'}); }
          }
          json(store.getReport(id));return;
        }
        if (req.method==='GET') {
          const report=store.getReport(id);
          if (!action) { json(report); return; }
          if (action==='verify') { json({...report.integrity,id,checkedAt:new Date().toISOString()}); return; }
          if(action==='analyses') {
            if(!report.integrity.verified||report.analyses?.some(a=>a.status==='SUCCEEDED'&&!a.verified))throw new AppError(409,'ANALYSIS_INTEGRITY_FAILED','报告或研判内容摘要校验失败，不能导出');
            res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${id}-analyses.json"`});
            res.end(JSON.stringify({reportId:id,reportHash:report.integrity.hash,archive:report.archive,analyses:report.analyses},null,2));return;
          }
          if (action==='evidence' || action==='llm-context') {
            if (!report.integrity.verified) throw new AppError(409,'REPORT_INTEGRITY_FAILED','报告摘要校验失败，不能导出');
            const content=action==='evidence' ? canonicalJSON(report.payload) : JSON.stringify(model.prepare(report.payload),null,2);
            res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="${id}-${action}.json"`,
              ...(action==='evidence' ? {'X-Content-SHA256':report.integrity.hash} : {})});
            res.end(content); return;
          }
        }
      }
      const ruleRoute = url.pathname.match(/^\/api\/rules\/(R\d+[AB]?)\/(history|validate|simulate|configurations|rollback)$/);
      if (ruleRoute) {
        const [, id, action] = ruleRoute;
        const def = definition(id);
        if (!def.supported) throw new AppError(400, 'RULE_NOT_SUPPORTED', def.reason);
        if (req.method === 'GET' && action === 'history') { json(store.history(id)); return; }
        if (req.method === 'POST') {
          const body = await readJson(req) as Record<string, unknown>;
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'INVALID_RULE', '规则请求必须是 JSON 对象');
          if (action === 'configurations') { json(store.publish(id, body)); return; }
          if (action === 'rollback') {
            const target = store.history(id).find(h => h.configuration.revision === body.targetRevision);
            if (!target) throw new AppError(404, 'VERSION_NOT_FOUND', '历史版本不存在');
            json(store.publish(id, { ...body, configuration: target.configuration, note: `从第 ${target.configuration.revision} 版恢复` })); return;
          }
          const candidate = validateConfiguration(id, body?.configuration);
          if (action === 'validate') { json({ valid: true, configuration: candidate }); return; }
          if (action === 'simulate') {
            const metrics = body?.metrics;
            if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics) || Object.values(metrics).some(v => v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))) throw new AppError(400, 'INVALID_SAMPLE', '样例特征必须为非负数值或明确的 null');
            const values = metrics as Record<string, number | null>;
            const fields = [...def.fields, ...(id === 'R7' ? [{ key: 'known', max: 1e9, integer: true }] : [])];
            if (Object.keys(values).some(k => !fields.some(f => f.key === k)) || fields.some(f => values[f.key] !== undefined && values[f.key] !== null && (values[f.key]! > f.max || f.integer && !Number.isInteger(values[f.key])))) throw new AppError(400, 'INVALID_SAMPLE', '样例包含未知字段或无效的范围/类型');
            json({ ...evaluateConfigured(candidate, values), mode: 'SAMPLE_ONLY', note: '仅对输入数值试算，假定数据质量前提成立；不会生成告警或替代真实事件核验。' }); return;
          }
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        const alerts = store.alerts();
        const runs = store.runs();
        json({
          alerts: alerts.length, pending: alerts.filter(a => a.status === '待复核' || a.status === '复核中').length,
          highAnomaly: alerts.filter(a => a.anomalyScore >= 50).length,
          confirmed: alerts.filter(a => a.status === '已确认').length,
          suspicionAlerts: alerts.filter(a => (a.suspicionScore ?? 0) > 0).length,
          recentAlerts: alerts.slice(0, 5), runs, busy,
        }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/alerts') {
        const all = store.alerts(url.searchParams.get('status') || '', (url.searchParams.get('q') || '').slice(0, 200));
        const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('page') || 1) || 1));
        const size = 10;
        json({ items: all.slice((page - 1) * size, page * size), total: all.length, page, pageSize: size }); return;
      }
      const alertRoute = url.pathname.match(/^\/api\/alerts\/(TG-[A-F0-9]{12})$/);
      if (req.method === 'GET' && alertRoute) { json(store.getAlert(alertRoute[1])); return; }
      const timelineRoute = url.pathname.match(/^\/api\/alerts\/(TG-[A-F0-9]{12})\/timeline$/);
      if (req.method === 'GET' && timelineRoute) { json(await source.replay(store.getAlert(timelineRoute[1]))); return; }
      const reviewRoute = url.pathname.match(/^\/api\/alerts\/(TG-[A-F0-9]{12})\/reviews$/);
      if (req.method === 'POST' && reviewRoute) { json(store.review(reviewRoute[1], await readJson(req))); return; }
      if (req.method === 'POST' && url.pathname === '/api/detections') {
        json(await detect(await readJson(req))); return;
      }
      const assets: Record<string, [string, string]> = {
        '/': ['web/index.html', 'text/html; charset=utf-8'],
        '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
        '/rules-ui.js': ['web/rules-ui.js', 'text/javascript; charset=utf-8'],
        '/reports-ui.js': ['web/reports-ui.js', 'text/javascript; charset=utf-8'],
        '/reports.css': ['web/reports.css', 'text/css; charset=utf-8'],
        '/replay.js': ['web/replay.js', 'text/javascript; charset=utf-8'],
        '/replay.css': ['web/replay.css', 'text/css; charset=utf-8'],
        '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
        '/favicon.svg': ['web/favicon.svg', 'image/svg+xml'],
      };
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, mime] = assets[url.pathname];
        const data = await readFile(resolve(ROOT, file));
        res.writeHead(200, { 'Content-Type': mime }); res.end(data); return;
      }
      throw new AppError(404, 'NOT_FOUND', '页面或接口不存在');
    } catch (error) {
      const failure = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', '服务处理失败，请稍后重试');
      if (!(error instanceof AppError)) console.error(`[${requestId}]`, error instanceof Error ? error.name : 'UnknownError');
      if (!res.headersSent) {
        res.writeHead(failure.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: failure.code, message: failure.message }, requestId }));
      }
    }
  });
  server.on('close', () => {
    scheduler.stop();
    if (scheduler.status().running) void scheduler.waitForIdle().then(() => store.close());
    else store.close();
  });
  server.requestTimeout = 30000;
  return { server, store, scheduler };
}
