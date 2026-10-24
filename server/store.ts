import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { AppError, REVIEW_STATUSES, type Alert, type BusinessPolicy, type DetectionRun, type Feature, type ReviewStatus, type RuleConfiguration } from './types.ts';
import { CATALOG, clone, definition, validateConfiguration } from './rules.ts';
import { buildReport, canonicalJSON, reportSnapshot, REPORT_TEMPLATE_VERSION, sha256, subjectOf, type EvidenceReport, type EvidenceReportPayload } from './reports.ts';
import type { ModelAnalysis } from './model.ts';
import { configuredBusinessPolicy } from './business-policy.ts';

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class Store {
  db: DatabaseSync;
  constructor(path: string, tenantId: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status,created_at);
      CREATE TABLE IF NOT EXISTS review_requests (alert_id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(alert_id,request_id));
      CREATE TABLE IF NOT EXISTS rule_configurations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rule_history (id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, note TEXT NOT NULL, PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS rule_requests (id TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(id,request_id));
      CREATE TABLE IF NOT EXISTS evidence_reports (
        id TEXT PRIMARY KEY, selection_key TEXT NOT NULL, revision INTEGER NOT NULL, snapshot_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        archived_at TEXT, archive_note TEXT, archive_actor TEXT, archive_request_id TEXT, archive_request_payload TEXT,
        UNIQUE(selection_key,revision));
      CREATE TABLE IF NOT EXISTS report_model_analyses (
        id TEXT PRIMARY KEY, report_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
        request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(report_id,request_id));`);
    for (const row of this.db.prepare("SELECT data FROM report_model_analyses WHERE status='GENERATING'").all()) {
      const task=JSON.parse(String(row.data)) as ModelAnalysis;
      this.finishAnalysis({...task,status:'FAILED',completedAt:new Date().toISOString(),error:'服务重启中断了模型请求，请手动重新生成。'});
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS business_policies (tenant_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS business_policy_history (tenant_id TEXT NOT NULL,version TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,version));`);
    const policy=configuredBusinessPolicy(tenantId);
    if(policy) {
      const current=this.businessPolicy(tenantId);
      if(current?.version===policy.version&&canonicalJSON(current)!==canonicalJSON(policy))throw new Error('业务策略内容已变化，请更新配置版本');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const save=this.db.prepare('INSERT OR IGNORE INTO business_policy_history(tenant_id,version,data,created_at) VALUES(?,?,?,?)');
        for(const item of [current,policy].filter((p):p is BusinessPolicy=>!!p))save.run(tenantId,item.version,JSON.stringify(item),new Date().toISOString());
        this.db.prepare('INSERT INTO business_policies(tenant_id,data) VALUES(?,?) ON CONFLICT(tenant_id) DO UPDATE SET data=excluded.data').run(tenantId,JSON.stringify(policy));
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    for (const rule of CATALOG.filter(r => r.supported)) {
      const configuration = clone(rule.defaults!);
      this.db.prepare('INSERT OR IGNORE INTO rule_configurations(id,revision,data) VALUES(?,?,?)').run(rule.id, 1, JSON.stringify(configuration));
      this.db.prepare('INSERT OR IGNORE INTO rule_history(id,revision,data,created_at,note) VALUES(?,?,?,?,?)').run(rule.id, 1, JSON.stringify(configuration), new Date().toISOString(), '初始配置');
    }
    const interrupted = this.db.prepare("SELECT data FROM runs WHERE status='RUNNING'").all();
    for (const row of interrupted) {
      const run = JSON.parse(String(row.data)) as DetectionRun;
      this.failRun(run, '服务重启中断了检测，可以重新运行同一窗口。');
    }
  }
  close() { this.db.close(); }
  businessPolicy(tenantId: string): BusinessPolicy | null {
    const row = this.db.prepare('SELECT data FROM business_policies WHERE tenant_id=?').get(tenantId);
    return row ? JSON.parse(String(row.data)) as BusinessPolicy : null;
  }
  configurations(): RuleConfiguration[] { return this.db.prepare('SELECT data FROM rule_configurations ORDER BY id').all().map(row => JSON.parse(String(row.data))); }
  configuration(id: string): RuleConfiguration {
    const def = definition(id);
    if (!def.supported) throw new AppError(400, 'RULE_NOT_SUPPORTED', def.reason);
    return JSON.parse(String(this.db.prepare('SELECT data FROM rule_configurations WHERE id=?').get(id)!.data));
  }
  history(id: string) {
    this.configuration(id);
    return this.db.prepare('SELECT data,created_at,note FROM rule_history WHERE id=? ORDER BY revision DESC').all(id)
      .map(row => ({ configuration: JSON.parse(String(row.data)) as RuleConfiguration, createdAt: String(row.created_at), note: String(row.note) }));
  }
  publish(id: string, body: unknown): RuleConfiguration {
    const data = body as Record<string, unknown> | null;
    const config = validateConfiguration(id, data?.configuration);
    const expected = data?.expectedRevision; const requestId = String(data?.requestId || '');
    const note = typeof data?.note === 'string' ? data.note.trim() : '保存规则配置';
    if (!Number.isSafeInteger(expected) || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId) || !note || note.length > 200) throw new AppError(400, 'INVALID_RULE', '配置版本、请求标识或变更说明无效');
    const payload = JSON.stringify({ config, note });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT payload,result FROM rule_requests WHERE id=? AND request_id=?').get(id, requestId);
      if (prior) {
        if (prior.payload !== payload) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同配置');
        this.db.exec('COMMIT'); return JSON.parse(String(prior.result));
      }
      const current = this.configuration(id);
      if (current.revision !== expected) throw new AppError(409, 'VERSION_CONFLICT', '规则已被更新，请重新载入当前配置');
      config.revision = current.revision + 1; config.version = `${id}-v0.2.${config.revision}`;
      const encoded = JSON.stringify(config);
      this.db.prepare('UPDATE rule_configurations SET revision=?,data=? WHERE id=?').run(config.revision, encoded, id);
      this.db.prepare('INSERT INTO rule_history(id,revision,data,created_at,note) VALUES(?,?,?,?,?)').run(id, config.revision, encoded, new Date().toISOString(), note);
      this.db.prepare('INSERT INTO rule_requests(id,request_id,payload,result) VALUES(?,?,?,?)').run(id, requestId, payload, encoded);
      this.db.exec('COMMIT'); return config;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getRun(id: string): DetectionRun | null {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    return row ? JSON.parse(String(row.data)) : null;
  }
  runs(): DetectionRun[] {
    return this.db.prepare('SELECT data FROM runs ORDER BY started_at DESC LIMIT 20').all().map(row => JSON.parse(String(row.data)));
  }
  saveRun(run: DetectionRun) {
    this.db.prepare('INSERT INTO runs(id,status,started_at,data) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,started_at=excluded.started_at,data=excluded.data')
      .run(run.id, run.status, run.startedAt, JSON.stringify(run));
  }
  failRun(run: DetectionRun, error: string) {
    this.saveRun({ ...run, status: 'FAILED', completedAt: new Date().toISOString(), error });
  }
  completeRun(run: DetectionRun, features: Feature[], tenantId: string, sqlHash: string, elapsedMs: number) {
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let alertCount = 0;
      for (const feature of features) {
        if (feature.anomalyScore === null || feature.anomalyScore === 0) continue;
        const id = 'TG-' + digest([run.id, feature.ruleId || 'R7', feature.videoId, feature.source, feature.eventType, feature.contextId || '']).slice(0, 12).toUpperCase();
        const alert: Alert = {
          id, runId: run.id, tenantId, sourceMode: run.sourceMode, videoId: feature.videoId, ruleId: feature.ruleId || 'R7', ruleName: feature.ruleName || '视频鉴权失败异常',
          scenario: feature.scenario, source: feature.source, eventType: feature.eventType,
          windowStart: feature.windowStart || run.windowStart, windowEnd: feature.windowEnd || run.windowEnd, anomalyScore: feature.anomalyScore,
          suspicionScore: feature.suspicionScore, ruleVersion: feature.configuration?.version || run.ruleVersion, sqlHash, feature,
          status: '待复核', version: 1, createdAt: now, updatedAt: now, reviews: [],
        };
        this.db.prepare('INSERT OR IGNORE INTO alerts(id,run_id,status,created_at,data) VALUES (?,?,?,?,?)')
          .run(id, run.id, alert.status, now, JSON.stringify(alert));
        alertCount++;
      }
      const completed: DetectionRun = { ...run, status: 'SUCCEEDED', completedAt: now, elapsedMs, features, alertCount, error: null };
      this.saveRun(completed);
      this.db.exec('COMMIT');
      return completed;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  alerts(status = '', query = ''): Alert[] {
    if (status && !REVIEW_STATUSES.includes(status as ReviewStatus)) throw new AppError(400, 'INVALID_STATUS', '复核状态无效');
    const rows = status
      ? this.db.prepare('SELECT data FROM alerts WHERE status=? ORDER BY created_at DESC,id DESC').all(status)
      : this.db.prepare('SELECT data FROM alerts ORDER BY created_at DESC,id DESC').all();
    const needle = query.trim().toLowerCase();
    return rows.map(row => JSON.parse(String(row.data)) as Alert)
      .filter(alert => !needle || `${alert.id} ${alert.videoId} ${alert.feature.subjectId || ''} ${(alert.feature.relatedVideoIds || []).join(' ')}`.toLowerCase().includes(needle));
  }
  getAlert(id: string): Alert {
    const row = this.db.prepare('SELECT data FROM alerts WHERE id=?').get(id);
    if (!row) throw new AppError(404, 'ALERT_NOT_FOUND', '告警不存在');
    return JSON.parse(String(row.data));
  }
  reports() {
    return this.db.prepare('SELECT id FROM evidence_reports ORDER BY created_at DESC,id DESC LIMIT 100').all().map(row => {
      const report = this.getReport(String(row.id)), p = report.payload;
      return { id:p.id, revision:p.revision, createdAt:p.createdAt, archivedAt:report.archive?.archivedAt || null,
        alertCount:p.facts.length, ruleIds:[...new Set(p.facts.map(f=>f.ruleId))], subjects:[...new Set(p.facts.map(f=>f.subject.id))],
        maxAnomaly:Math.max(...p.facts.map(f=>f.anomalyScore)), suspicionUnknown:p.facts.some(f=>f.suspicionScore===null),
        scenario:p.snapshot.run.scenario, sourceMode:p.snapshot.run.sourceMode, dataBatchId:p.snapshot.run.dataBatchId,
        runId:p.snapshot.run.id, verified:report.integrity.verified };
    });
  }
  reportCandidates() {
    const all = this.alerts();
    return { total:all.length, items:all.slice(0,100).map(a=>({ id:a.id,runId:a.runId,ruleId:a.ruleId || 'R7',ruleName:a.ruleName || '视频鉴权失败异常',
      subject:subjectOf(a.feature), anomalyScore:a.anomalyScore,suspicionScore:a.suspicionScore,scenario:a.scenario,
      windowStart:a.windowStart,windowEnd:a.windowEnd,status:a.status })) };
  }
  getReport(id: string): EvidenceReport {
    const row = this.db.prepare('SELECT * FROM evidence_reports WHERE id=?').get(id);
    if (!row) throw new AppError(404,'REPORT_NOT_FOUND','报告不存在');
    let payload: EvidenceReportPayload;
    try { payload = JSON.parse(String(row.payload)); } catch { throw new AppError(409,'REPORT_INTEGRITY_FAILED','报告内容不可读取，请检查留存文件'); }
    return { payload, analyses:this.analyses(id).map(a=>({...a,verified:a.status==='SUCCEEDED'&&a.reportHash===row.payload_hash&&!!a.content&&a.outputHash===sha256(canonicalJSON(a.content))&&(a.input===undefined||a.inputHash===sha256(canonicalJSON(a.input)))})), integrity:{algorithm:'SHA-256',hash:String(row.payload_hash),verified:payload.id===id && sha256(canonicalJSON(payload))===row.payload_hash},
      archive:row.archived_at ? {archivedAt:String(row.archived_at),note:String(row.archive_note),actor:String(row.archive_actor)} : null };
  }
  analyses(reportId:string):ModelAnalysis[] {
    return this.db.prepare('SELECT data FROM report_model_analyses WHERE report_id=? ORDER BY rowid DESC').all(reportId).map(row=>JSON.parse(String(row.data)));
  }
  startAnalysis(id:string,body:unknown,meta:{model:string;promptVersion:string;inputHash:string;input?:unknown}) {
    const data=body as Record<string,unknown>|null, requestId=String(data?.requestId||'');
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)||!/^[a-f0-9]{64}$/.test(String(data?.expectedHash||''))) throw new AppError(400,'INVALID_ANALYSIS','模型请求标识或报告摘要无效');
    const report=this.getReport(id);
    if(!report.integrity.verified || report.integrity.hash!==data!.expectedHash) throw new AppError(409,'REPORT_INTEGRITY_FAILED','报告摘要校验失败或版本已变化');
    const fingerprint=canonicalJSON({hash:report.integrity.hash,...meta});
    const prior=this.db.prepare('SELECT data,fingerprint FROM report_model_analyses WHERE report_id=? AND request_id=?').get(id,requestId);
    if(prior) {
      if(prior.fingerprint!==fingerprint)throw new AppError(409,'IDEMPOTENCY_CONFLICT','同一请求标识不能用于不同研判输入');
      return {task:JSON.parse(String(prior.data)) as ModelAnalysis,reused:true};
    }
    if(report.archive)throw new AppError(409,'REPORT_ALREADY_ARCHIVED','归档版本不再新增研判，请创建新的报告版本');
    if(this.db.prepare("SELECT id FROM report_model_analyses WHERE status='GENERATING' LIMIT 1").get())throw new AppError(409,'ANALYSIS_BUSY','已有模型请求进行中，请稍后刷新');
    const task:ModelAnalysis={id:'AI-'+randomUUID(),reportId:id,reportHash:report.integrity.hash,...meta,outputHash:null,createdAt:new Date().toISOString(),completedAt:null,status:'GENERATING',content:null,error:null,usage:null,review:null};
    this.db.prepare('INSERT INTO report_model_analyses(id,report_id,status,data,request_id,fingerprint) VALUES(?,?,?,?,?,?)').run(task.id,id,task.status,JSON.stringify(task),requestId,fingerprint);
    return {task,reused:false};
  }
  finishAnalysis(task:ModelAnalysis) {
    this.db.prepare('UPDATE report_model_analyses SET status=?,data=? WHERE id=?').run(task.status,JSON.stringify(task),task.id);
  }
  reviewAnalysis(id:string,analysisId:string,body:unknown) {
    const data=body as Record<string,unknown>|null, note=typeof data?.note==='string'?data.note.trim():'', requestId=String(data?.requestId||'');
    if(!['ADOPTED','REJECTED'].includes(String(data?.decision)) || !note || note.length>500 || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))throw new AppError(400,'INVALID_ANALYSIS_REVIEW','请选择采用或不采用，并填写审核依据');
    const report=this.getReport(id), row=this.db.prepare('SELECT data FROM report_model_analyses WHERE report_id=? AND id=?').get(id,analysisId);
    if(!row)throw new AppError(404,'ANALYSIS_NOT_FOUND','研判草稿不存在');
    const task=JSON.parse(String(row.data)) as ModelAnalysis;
    if(!report.integrity.verified || !report.analyses?.find(a=>a.id===analysisId)?.verified)throw new AppError(409,'ANALYSIS_INTEGRITY_FAILED','报告或研判内容校验失败，不能采用');
    if(task.review) {
      if(task.review.requestId===requestId&&task.review.decision===data!.decision&&task.review.note===note)return report;
      throw new AppError(409,'ANALYSIS_ALREADY_REVIEWED','该草稿已审核；重新生成研判可保留新的审核记录');
    }
    if(report.archive)throw new AppError(409,'REPORT_ALREADY_ARCHIVED','归档版本的研判审核已锁定');
    task.review={decision:data!.decision as 'ADOPTED'|'REJECTED',note,requestId,reviewedAt:new Date().toISOString(),actor:'本地风控运营'};
    this.finishAnalysis(task); return this.getReport(id);
  }
  createReport(body: unknown) {
    const data = body as {alertIds?:unknown} | null;
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k=>k!=='alertIds') || !Array.isArray(data.alertIds)
      || data.alertIds.length < 1 || data.alertIds.length > 8 || new Set(data.alertIds).size !== data.alertIds.length
      || data.alertIds.some(id=>typeof id!=='string' || !/^TG-[A-F0-9]{12}$/.test(id))) throw new AppError(400,'INVALID_REPORT','请选择 1～8 条不同的告警');
    const ids = [...data.alertIds].sort() as string[];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const alerts = ids.map(id=>this.getAlert(id));
      if (new Set(alerts.map(a=>a.runId)).size!==1 || new Set(alerts.map(a=>a.tenantId)).size!==1 || new Set(alerts.map(a=>a.sourceMode)).size!==1) throw new AppError(400,'REPORT_SCOPE_MISMATCH','同一报告只能选择同租户、同来源、同一次检测产生的告警');
      const run = this.getRun(alerts[0].runId);
      if (!run || run.status!=='SUCCEEDED') throw new AppError(409,'REPORT_RUN_UNAVAILABLE','关联检测没有可用的成功快照');
      const snapshot = reportSnapshot(alerts,run);
      if (Buffer.byteLength(canonicalJSON(snapshot))>524288) throw new AppError(413,'REPORT_TOO_LARGE','所选证据快照过大，请减少告警数量');
      const snapshotKey = sha256(canonicalJSON({templateVersion:REPORT_TEMPLATE_VERSION,snapshot}));
      const existing = this.db.prepare('SELECT id FROM evidence_reports WHERE snapshot_key=?').get(snapshotKey);
      if (existing) { const report=this.getReport(String(existing.id)); this.db.exec('COMMIT'); return {report,reused:true}; }
      const selectionKey = sha256(canonicalJSON(ids));
      const last = this.db.prepare('SELECT max(revision) AS revision FROM evidence_reports WHERE selection_key=?').get(selectionKey);
      const revision = Number(last?.revision || 0)+1, id='FR-'+snapshotKey.slice(0,12).toUpperCase(), now=new Date().toISOString();
      const payload = buildReport(snapshot,id,revision,now), content=canonicalJSON(payload);
      this.db.prepare('INSERT INTO evidence_reports(id,selection_key,revision,snapshot_key,payload,payload_hash,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id,selectionKey,revision,snapshotKey,content,sha256(content),now);
      const report=this.getReport(id); this.db.exec('COMMIT'); return {report,reused:false};
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  archiveReport(id: string, body: unknown) {
    const data=body as Record<string,unknown> | null;
    const note=typeof data?.note==='string' ? data.note.trim() : '', requestId=String(data?.requestId || '');
    if (!note || note.length>500 || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(String(data?.expectedHash || ''))) throw new AppError(400,'INVALID_ARCHIVE','请填写归档说明并使用有效报告摘要');
    const content=canonicalJSON({note,hash:data!.expectedHash});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const report=this.getReport(id);
      if (!report.integrity.verified) throw new AppError(409,'REPORT_INTEGRITY_FAILED','报告摘要校验失败，不能归档');
      if (report.integrity.hash!==data!.expectedHash) throw new AppError(409,'REPORT_VERSION_CONFLICT','报告版本已变化，请重新载入');
      const row=this.db.prepare('SELECT archive_request_id,archive_request_payload FROM evidence_reports WHERE id=?').get(id)!;
      if (report.archive) {
        if (row.archive_request_id===requestId && row.archive_request_payload===content) { this.db.exec('COMMIT'); return report; }
        throw new AppError(409,'REPORT_ALREADY_ARCHIVED','此版本已归档；新的复核内容请生成新版本');
      }
      if(report.analyses?.some(a=>a.status==='GENERATING'))throw new AppError(409,'ANALYSIS_BUSY','请等待模型请求结束后再归档');
      if(report.analyses?.some(a=>a.review?.decision==='ADOPTED'&&!a.verified))throw new AppError(409,'ANALYSIS_INTEGRITY_FAILED','已采用的研判附录摘要校验失败，不能归档');
      this.db.prepare('UPDATE evidence_reports SET archived_at=?,archive_note=?,archive_actor=?,archive_request_id=?,archive_request_payload=? WHERE id=?')
        .run(new Date().toISOString(),note,'本地风控运营',requestId,content,id);
      const archived=this.getReport(id); this.db.exec('COMMIT'); return archived;
    } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  review(id: string, body: unknown): Alert {
    const data = body as Record<string, unknown> | null;
    const status = String(data?.status || '') as ReviewStatus;
    const note = typeof data?.note === 'string' ? data.note.trim() : '';
    const requestId = String(data?.requestId || '');
    const expectedVersion = data?.expectedVersion;
    if (!REVIEW_STATUSES.includes(status) || status === '待复核') throw new AppError(400, 'INVALID_REVIEW', '请选择复核结论');
    if (!note || note.length > 500) throw new AppError(400, 'INVALID_REVIEW', '请填写 1～500 字的复核依据');
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId) || !Number.isSafeInteger(expectedVersion)) throw new AppError(400, 'INVALID_REVIEW', '复核请求标识或版本无效');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const alert = this.getAlert(id);
      const payload = JSON.stringify({ status, note });
      const prior = this.db.prepare('SELECT payload FROM review_requests WHERE alert_id=? AND request_id=?').get(id, requestId);
      if (prior) {
        if (prior.payload !== payload) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同复核内容');
        this.db.exec('COMMIT');
        return alert;
      }
      if (alert.version !== expectedVersion) throw new AppError(409, 'VERSION_CONFLICT', '该告警已更新，请刷新详情后重新复核');
      const now = new Date().toISOString();
      const updated: Alert = { ...alert, status, version: alert.version + 1, updatedAt: now,
        reviews: [...alert.reviews, { id: randomUUID(), status, note, actor: '本地风控运营', createdAt: now, requestId }] };
      this.db.prepare('UPDATE alerts SET status=?,data=? WHERE id=?').run(status, JSON.stringify(updated), id);
      this.db.prepare('INSERT INTO review_requests(alert_id,request_id,payload) VALUES (?,?,?)').run(id, requestId, payload);
      this.db.exec('COMMIT');
      return updated;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
