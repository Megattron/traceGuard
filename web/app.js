import { renderRulesPage, installRuleEditor } from '/rules-ui.js';
import { renderReportsPage, installReports, loadReports } from '/reports-ui.js';
import { mountReplay } from '/replay.js';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const state = { page: 'overview', health: null, overview: null, scheduler: null, rules: [], businessPolicy: null, alerts: [], total: 0, pageIndex: 1, status: '', query: '', selected: null, detecting: false, reviewing: false, reviewRequest: null };
let toastTimer;
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || '请求失败，请稍后重试');
  return payload.data;
}
function displayId(id, type = '') {
  if (!id) return id;
  const synthetic = id.startsWith('sim_') || id.includes(':case_supplement_v1:');
  if (['VIEWER', 'CREDENTIAL_VIEWER'].includes(type) && synthetic) {
    let hash = 2166136261;
    for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    return `116488${String(hash).padStart(13, '0')}`;
  }
  if (type === 'TOKEN' && synthetic) {
    const hash = seed => {
      let value = seed;
      for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
      return value.toString(16).padStart(8, '0');
    };
    return `tk_${hash(2166136261)}${hash(3339675911)}`;
  }
  const course = id.match(/^sim_course_(\d+)$/);
  return course ? `980107c0ab${Number(course[1]).toString(16).padStart(22, '0')}` : id;
}
const entityId = f => displayId(f.subjectId || f.videoId, f.subjectType) || '未映射主体';
const entityType = f => ({ VIEWER: '认证观众', CREDENTIAL_VIEWER: '凭证绑定观众（身份未核实）', TOKEN: '授权凭证', VIDEO: '视频主体' })[f.subjectType] || '视频主体';
const scoreLevel = score => score === null ? '数据不足' : score >= 50 ? '高危险' : score >= 25 ? '注意' : score > 0 ? '一般' : '无计分命中';
const scoreClass = score => score === null ? 'neutral' : score >= 50 ? 'danger' : score >= 25 ? 'warning' : score > 0 ? 'info' : 'neutral';
const ratio = n => n === null ? '—' : `${(n * 100).toFixed(1)}%`;
const number = n => Number(n || 0).toLocaleString('zh-CN');
const timestamp = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const statusClass = status => status === '已误报' ? 'success' : status === '已确认' ? 'danger' : status === '待复核' ? 'warning' : 'info';
const tag = (label, kind = 'neutral') => `<span class="tag ${kind}">${esc(label)}</span>`;
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function heading(title, description, action = true) {
  return `<div class="page-heading"><div><div class="eyebrow">CONTENT SECURITY / ${state.page.toUpperCase()}</div><h1>${title}</h1><p>${description}</p></div>${action ? '<button class="button primary" data-detect>＋ 运行检测</button>' : ''}</div>`;
}
function alertTable(alerts) {
  if (!alerts.length) return `<div class="empty"><div class="empty-icon">◎</div><h3>暂无告警</h3><p>运行一次失败集中场景检测，查看从数据到复核的完整流程。</p><button class="button secondary" data-detect>运行检测 →</button></div>`;
  return `<div class="table-scroll"><table><thead><tr><th>告警 / 生成时间</th><th>告警主体</th><th>异常分 A</th><th>嫌疑分 S</th><th>复核状态</th><th></th></tr></thead><tbody>${alerts.map(a => `<tr><td><button class="text-link mono" data-alert="${esc(a.id)}">${esc(a.id)}</button><small>${timestamp(a.createdAt)}</small></td><td><span class="video-id mono" title="${esc(entityId(a.feature))}">${esc(entityId(a.feature))}</span><small>${esc(a.ruleId || 'R7')} · ${esc(a.ruleName || '视频鉴权失败异常')}</small></td><td><b class="score ${scoreClass(a.anomalyScore)}">${a.anomalyScore}</b> ${tag(a.feature.tier || scoreLevel(a.anomalyScore), scoreClass(a.anomalyScore))}</td><td><b class="score neutral">${a.suspicionScore ?? '—'}</b><small>${suspicionHint(a)}</small></td><td>${tag(a.status, statusClass(a.status))}</td><td><button class="text-link" data-alert="${esc(a.id)}">查看证据 ↗</button></td></tr>`).join('')}</tbody></table></div>`;
}
function runTable(runs) {
  if (!runs.length) return '<div class="empty compact"><p>尚未运行检测。选一个窗口，建立第一份可追溯记录。</p></div>';
  return `<div class="table-scroll"><table><thead><tr><th>基准窗口 / 场景</th><th>执行结果</th><th>告警</th><th>耗时</th><th></th></tr></thead><tbody>${runs.slice(0, 6).map(run => {
    const unavailable = run.features.filter(f => f.computeStatus === 'UNAVAILABLE').length;
    const label = run.status === 'FAILED' ? '检测失败' : run.status === 'RUNNING' ? '检测中' : !run.features.length ? '未观察到事件' : unavailable === run.features.length ? '数据不足' : '检测完成';
    const kind = run.status === 'FAILED' ? 'danger' : unavailable || !run.features.length ? 'neutral' : 'success';
    return `<tr><td><span class="mono">${esc(run.windowStart.slice(5, 16))} — ${esc(run.windowEnd.slice(11, 16))}</span><small>${esc(run.scenario)} · ${esc(run.configurations?.map(c => c.id).join(' / ') || run.ruleVersion)}</small></td><td>${tag(label, kind)}${run.error ? `<small class="error-text">${esc(run.error)}</small>` : ''}</td><td>${run.alertCount}</td><td class="muted">${run.elapsedMs === null ? '—' : (run.elapsedMs / 1000).toFixed(2) + ' s'}</td><td><button class="text-link" data-run="${esc(run.id)}">查看结果 →</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function overviewPage() {
  const o = state.overview;
  const latest = o.runs.find(r => r.status === 'SUCCEEDED');
  const features = latest?.features || [];
  const r7 = features.filter(f => !f.ruleId || f.ruleId === 'R7');
  const observed = r7.length ? r7.reduce((n, f) => n + f.observed, 0) : features.length;
  const failed = r7.reduce((n, f) => n + f.failed, 0);
  const schedule = state.scheduler;
  const scheduleLabel = !schedule?.enabled ? '未启用' : schedule.checked === schedule.total ? '本批次完成' : schedule.last?.error ? '等待重试' : schedule.running ? '检测中' : '轮巡中';
  const scheduleKind = schedule?.last?.error ? 'warning' : schedule?.enabled ? 'success' : 'neutral';
  const sceneNames = { rapid_pull: '快速拉片', token_shared: '多环境 token', failure_burst: '失败集中', scope_violation: '范围外访问', missing_chain: '授权步骤缺失', unknown_inputs: '未知结果', client_tool: '工具访问', sustained_access: '夜间访问' };
  const next = schedule?.next ? `${sceneNames[schedule.next.scenario] || schedule.next.scenario} · ${schedule.next.windowStart.slice(11)}` : '全部预设窗口已检查';
  const last = schedule?.last ? `${sceneNames[schedule.last.scenario] || schedule.last.scenario} · ${schedule.last.error || (schedule.last.reused ? '复用已保存结果' : `新生成 ${schedule.last.alertCount} 条告警`)}` : '尚未开始';
  return `${heading('视频访问风险总览', '识别访问异常，保留判断依据，让每条告警都有复核结果。')}
    <section class="metric-grid" aria-label="风险指标">
      ${[
        ['已生成告警', o.alerts, '来自已保存的检测结果', '◎', ''],
        ['待处理告警', o.pending, '待复核与复核中', '◷', 'warning'],
        ['高危险异常', o.highAnomaly, '异常分 A ≥ 50', '↗', 'danger'],
        ['已确认异常', o.confirmed, '已保存人工复核依据', '✓', 'success'],
      ].map(([name, value, note, icon, kind]) => `<button class="metric" data-nav="alerts"><span class="metric-name">${name}<i class="${kind}">${icon}</i></span><strong>${number(value)}</strong><span class="metric-note">${note}</span></button>`).join('')}
    </section>
    <section class="card schedule-card" aria-label="演示批次自动轮巡"><div class="card-heading"><div><h2>演示批次自动轮巡</h2><p>服务运行期间按预设窗口逐项检测；本批次完成后停止，不代表实时监控</p></div>${tag(scheduleLabel, scheduleKind)}</div><div class="schedule-details"><span>进度 <b>${schedule?.checked ?? 0} / ${schedule?.total ?? 8}</b></span><span>下一项 <b>${esc(next)}</b></span><span>最近检查 <b>${esc(last)}</b></span></div></section>
    <div class="notice"><span class="notice-icon">i</span><div><b>访问异常与盗版嫌疑分别判断</b><p>按规则保留可计算前提和触发配置。每条告警展示原生主体及单规则贡献，不把 token 风险复制给绑定观众，不把跨规则分数直接相加；缺少嫌疑准入依据时显示待核实。</p></div>${tag(`当前启用 ${state.rules.filter(r => r.configuration?.enabled).length} 条规则`, 'info')}</div>
    <div class="overview-grid"><section class="card"><div class="card-heading"><div><h2>近期告警</h2><p>从视频主体下钻，查看触发时的特征与评分</p></div><button class="text-link" data-nav="alerts">全部告警 →</button></div>${alertTable(o.recentAlerts)}</section>
    <aside class="card scope-card"><div class="card-heading"><div><h2>最近检测概况</h2><p>固定窗口 · 同一结果口径</p></div><span class="status-pip"></span></div>${latest ? `<div class="snapshot-total"><span>${r7.length ? 'TS 鉴权事件 · R7 口径' : '规则评估结果'}</span><strong>${number(observed)}<small>条</small></strong></div><dl class="definition"><dt>${r7.length ? '失败事件' : '标签命中'}</dt><dd>${r7.length ? number(failed) : features.filter(f => f.labelHit).length}</dd><dt>视频主体</dt><dd>${new Set(features.map(f => f.videoId)).size}</dd><dt>检测起点</dt><dd class="mono">${esc(latest.windowStart.slice(5, 16))}</dd><dt>窗口长度</dt><dd>10 分钟</dd><dt>数据类别</dt><dd>${state.health.sourceMode === 'clickhouse' ? '合成验证事件' : '本地演示事件'}</dd></dl>` : '<div class="snapshot-total"><span>准备好开始检测</span><strong>R7<small>视频访问异常</small></strong></div><p class="muted">默认失败集中窗口包含 200 条事件，适合演示告警生成与人工复核。</p>'}<div class="scope-bottom"><span class="scope-mark">01</span><div><b>选取窗口 → 生成告警 → 保存复核</b><p>所有记录保存在服务端，刷新页面后仍可查看。</p></div></div></aside></div>
    <section class="card"><div class="card-heading"><div><h2>检测运行记录</h2><p>记录成功、数据不足和失败，查询异常不会被当作安全结论</p></div><button class="text-link" data-refresh>刷新记录 ↻</button></div>${runTable(o.runs)}</section>`;
}
function alertsPage() {
  const pages = Math.max(1, Math.ceil(state.total / 10));
  return `${heading('告警中心', '先核对特征与身份范围，再保存你的复核依据。')}
    <div class="filter-bar"><label class="search-field"><span>⌕</span><input id="alert-search" type="search" placeholder="搜索告警、主体或视频 ID" aria-label="搜索告警、主体或视频 ID" value="${esc(state.query)}"></label><select id="status-filter" aria-label="复核状态"><option value="">全部复核状态</option>${['待复核', '复核中', '观察中', '已确认', '已误报'].map(s => `<option ${state.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select><button class="button secondary" data-filter>筛选</button><span class="muted filter-count">共 ${state.total} 条告警</span></div>
    <section class="card">${alertTable(state.alerts)}<div class="pagination"><span>第 ${state.pageIndex} / ${pages} 页 · 每页 10 条</span><div><button class="button secondary small" data-page="-1" ${state.pageIndex <= 1 ? 'disabled' : ''}>上一页</button><button class="button secondary small" data-page="1" ${state.pageIndex >= pages ? 'disabled' : ''}>下一页</button></div></div></section><p class="page-note">人工复核更新工作状态，保留触发时的特征、规则版本与评分。</p>`;
}
function rulePage() {
  const p = state.businessPolicy;
  const policyCard = p ? `<section class="card policy-card"><div class="card-heading"><div><h2>租户业务前提</h2><p>仅对租户 ${esc(p.tenantId)} 的新检测生效 · ${esc(p.version)}</p></div>${tag('已配置', 'success')}</div><div class="policy-grid"><div><span>下载 / 预取</span><b>${p.downloadAllowed ? "允许下载" : "禁止下载"} / ${p.prefetchAllowed ? "允许预取" : "禁止预取"}</b></div><div><span>账号共享</span><b>${p.accountSharingAllowed ? "允许" : "禁止"}</b></div><div><span>Key 缓存上限</span><b>${Math.round(p.keyCacheTtlSeconds / 60)} 分钟</b></div><div><span>续期规则</span><b>原观众发起 · 保留原授权范围</b></div></div><p class="inline-hint">策略自 ${esc(p.effectiveFrom.replace('T', ' '))} 起生效；到期后须重新获取 Key，续期留存授权快照。满足数据与业务前提的 R1、R2、R4B 可计嫌疑分 S；辅助规则不直接累加为嫌疑总分。</p></section>` : `<section class="card policy-card"><div class="card-heading"><div><h2>租户业务前提</h2><p>当前租户尚未配置业务策略</p></div>${tag('未配置', 'warning')}</div></section>`;
  return `${policyCard}${renderRulesPage(state.rules)}`;
}
function suspicionHint(alert) {
  if (alert.feature?.businessPolicyVersion && (alert.suspicionScore ?? 0) === 0) return `业务前提已核实 · ${alert.ruleId} 暂无嫌疑分映射`;
  if ((alert.suspicionScore ?? 0) > 0) return ({ R1: '必要授权步骤缺失后的获准访问线索', R2: '禁止下载/预取下的异常拉取线索', R4B: '禁止账号共享下的凭证跨环境使用线索', R4A: '范围外授权访问证据' })[alert.ruleId] || '主要嫌疑证据';
  if (alert.suspicionScore === null) {
    const reason = alert.feature?.reason;
    return ({ BUSINESS_DOWNLOAD_POLICY_UNVERIFIED: '是否允许下载/预取尚未核实',
      BUSINESS_SHARING_POLICY_UNVERIFIED: '是否允许共享/多端使用尚未核实',
      BUSINESS_CACHE_POLICY_UNVERIFIED: '缓存/续期策略尚未核实' })[reason] || reasonText(reason) || '嫌疑计算依据不足';
  }
  if (alert.ruleId === 'R4A') return '范围外授权访问证据';
  return !alert.ruleId || alert.ruleId === 'R7' ? '访问失败本身不代表侵权' : '辅助特征尚未关联主要嫌疑证据';
}
function reasonText(reason) {
  return ({ BUSINESS_DOWNLOAD_POLICY_UNVERIFIED: '合法下载和预取策略尚待核实，未计算嫌疑分', IDENTITY_UNVERIFIED: '缺少可靠的实际请求者身份',
    INCOMPLETE_OR_UNVERIFIED_SOURCE: '来源覆盖不完整或采样口径未核实', MISSING_OR_AMBIGUOUS_MEDIA: '媒体映射缺失或不唯一',
    WINDOW_OUTSIDE_BATCH: '本规则回溯窗口超出验证批次，未执行该规则', BUSINESS_CACHE_POLICY_UNVERIFIED: '合法缓存策略尚待核实，未计算嫌疑分', BUSINESS_SHARING_POLICY_UNVERIFIED: '合法共享或多路播放策略尚待核实，未计算嫌疑分', MISSING_OR_AMBIGUOUS_TOKEN_HISTORY: '授权快照缺失或存在冲突', UNKNOWN_CLIENT_ENVIRONMENT: '客户端环境未知或来源不可信', INSUFFICIENT_VALID_EVENTS: '有效客户端事件不足', MISSING_TRUSTED_STATE: '缺少可信且有效的播放状态', MISSING_PROTOCOL_OR_AUTHORIZATION_HISTORY: '协议或历史授权依据不完整', SOURCE_OR_VALIDITY_NOT_COMPLETE: '前置步骤回溯覆盖或有效期不可确定', INCONSISTENT_MANIFEST: '媒体清单定义不一致', INSUFFICIENT_EVENTS: '有效事件不足', AMBIGUOUS_EVENT_ORDER: '事件先后无法确定',
    ZERO_MEAN_GAP: '请求间隔均值为零', UNKNOWN_CLIENT_UA: '客户端 UA 未知', INSUFFICIENT_KNOWN_RESULTS: '已知结果样本不足',
    MISSING_REQUIRED_FEATURE: '缺少必要特征', MISSING_VIDEO_MAPPING: '缺少视频映射', RULE_DISABLED: '规则已停用', NO_KNOWN_RESULTS: '没有已知鉴权结果' })[reason] || reason;
}
function featureEntries(feature) {
  if (!feature.metrics) return [['全部事件', feature.observed], ['鉴权通过', feature.passed], ['鉴权失败', feature.failed], ['结果未知', feature.unknown], ['已知结果 N', feature.known], ['失败率', ratio(feature.failureRatio)]];
  const fields = state.rules.find(r => r.id === feature.ruleId)?.fields || [];
  const names = { passed: '鉴权通过', failed: '鉴权失败', unknown: '结果未知', known: '已知结果 N', failureRatio: '失败率' };
  return Object.entries(feature.metrics).map(([key, value]) => {
    const field = fields.find(f => f.key === key);
    const duration = key === 'contentSeconds' && value !== null;
    const minuteCount = key === 'activeMinutes' || duration;
    const displayValue = duration ? value / 60 : value;
    const formatted = displayValue === null ? '—' : field?.unit === '%' || key === 'failureRatio' ? ratio(displayValue) : Number.isInteger(displayValue) ? number(displayValue) : Number(displayValue.toFixed(1)).toLocaleString('zh-CN');
    const label = duration ? '去重内容时长' : key === 'activeMinutes' ? '活跃时长' : field?.label || names[key] || key;
    return [label, minuteCount && value !== null ? `${formatted} 分钟` : formatted];
  });
}
function openRun(id) {
  const run = state.overview.runs.find(r => r.id === id); if (!run) return;
  $('#results-content').innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">DETECTION RESULTS</span><h2>检测结果</h2></div><button class="icon-button" data-close="results-dialog" aria-label="关闭检测结果">×</button></div><div class="dialog-body"><p>${esc(run.windowStart)} — ${esc(run.windowEnd.slice(11, 16))} · ${esc(run.scenario)}</p><div class="info-note">每项结果单独保存规则版本和自然上下文，以下分数不相加。R9 标签为 0 分，不创建告警。</div>${run.error ? `<p class="error-text">${esc(run.error)}</p>` : ''}${run.features.length ? run.features.map(f => `<section class="result-item"><div class="row"><b>${esc(f.ruleId || 'R7')} · ${esc(f.ruleName || '视频鉴权失败异常')}</b>${tag(f.tier || (f.computeStatus === 'UNAVAILABLE' ? '数据不足' : scoreLevel(f.anomalyScore)), scoreClass(f.anomalyScore))}<span class="result-score">A ${f.anomalyScore ?? '—'} / S ${f.suspicionScore ?? '—'}</span></div><p class="muted mono">${esc(entityId(f))}${f.actorId ? ` · ${esc(displayId(f.actorId, 'VIEWER'))}` : ''}</p><div class="result-metrics">${featureEntries(f).map(([label, value]) => `<span>${esc(label)} <b>${esc(value)}</b></span>`).join('')}</div>${f.reason ? `<p class="inline-hint">${esc(reasonText(f.reason))}</p>` : ''}<p class="inline-hint">${esc(f.windowStart || run.windowStart)} — ${esc(f.windowEnd || run.windowEnd)} · ${esc(entityType(f))}</p>${(f.limitations || []).map(t => `<p class="inline-hint">${esc(t)}</p>`).join('')}<small class="muted">${esc(f.configuration?.version || run.ruleVersion)}</small></section>`).join('') : '<p class="muted">该窗口未观察到符合当前规则来源范围的事件，不能据此确认安全。</p>'}</div>`;
  const absent = (run.configurations || []).filter(c => !run.features.some(f => (f.ruleId || 'R7') === c.id));
  if (run.status === 'SUCCEEDED' && absent.length) $('#results-content .dialog-body').insertAdjacentHTML('beforeend', absent.map(c => `<section class="result-item"><div class="row"><b>${esc(c.id)} · ${esc(state.rules.find(r => r.id === c.id)?.name || '')}</b>${tag('未观察到适用事件')}</div><p class="inline-hint">本规则 ${esc(state.rules.find(r => r.id === c.id)?.window || '')} 窗口内未观察到可用输入，不能据此确认安全。</p><small class="muted">${esc(c.version)}</small></section>`).join(''));
  $('#results-dialog').showModal();
}
function render() {
  document.querySelectorAll('[data-nav]').forEach(button => button.classList.toggle('active', button.dataset.nav === state.page));
  if (!state.overview || !state.rules.length) return;
  $('#app').innerHTML = state.page === 'overview' ? overviewPage() : state.page === 'alerts' ? alertsPage() : state.page === 'reports' ? renderReportsPage() : rulePage();
}
async function load() {
  const [health, overview, rules, businessPolicy, scheduler] = await Promise.all([api('/api/health'), api('/api/overview'), api('/api/rules'), api('/api/business-policy'), api('/api/scheduler')]);
  Object.assign(state, { health, overview, rules, businessPolicy, scheduler });
  $('#source-band').innerHTML = `<span class="source-label">测试环境</span><span>${health.sourceMode === 'clickhouse' ? '合成验证数据' : '本地演示数据'}</span><span class="band-separator">/</span><span>租户 <b class="mono">${esc(health.tenantId)}</b></span><span class="band-right">验证范围 2026.10.16 — 10.23</span>`;
  if (state.page === 'alerts') await loadAlerts(); else if(state.page==='reports') await loadReports(); else render();
}
async function loadAlerts() {
  const params = new URLSearchParams({ status: state.status, q: state.query, page: String(state.pageIndex) });
  const result = await api('/api/alerts?' + params);
  state.alerts = result.items; state.total = result.total;
  if (state.pageIndex > Math.max(1, Math.ceil(state.total / 10))) { state.pageIndex = 1; return loadAlerts(); }
  render();
}
async function navigate(page) {
  const base=page.split('/')[0];
  state.page = ['overview', 'alerts', 'rule','reports'].includes(base) ? base : 'overview';
  location.hash = state.page==='reports'?page:state.page;
  if (state.page === 'alerts') await loadAlerts(); else if(state.page==='reports') await loadReports(page.split('/')[1]); else render();
}
function renderDetail(a) {
  const f = a.feature;
  $('#detail-content').innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">ALERT EVIDENCE</span><h2>${esc(a.id)}</h2></div><button class="icon-button" data-close="detail-dialog" aria-label="关闭告警详情">×</button></div><div class="detail-body"><div class="row">${tag(a.status, statusClass(a.status))}${tag(a.ruleVersion)}${tag(a.sourceMode === 'clickhouse' ? '合成验证数据' : '本地演示数据', 'info')}</div><h3 class="detail-entity mono">${esc(entityId(a.feature))}</h3><p class="muted">${esc(entityType(f))} · ${esc(a.windowStart)} — ${esc(a.windowEnd.slice(11, 16))}（北京时间）</p><div class="detail-scores"><div><span>异常分 A</span><strong class="${scoreClass(a.anomalyScore)}">${a.anomalyScore}<small>单规则贡献</small></strong>${tag(a.feature.tier || scoreLevel(a.anomalyScore), scoreClass(a.anomalyScore))}</div><div><span>盗版嫌疑分 S</span><strong>${a.suspicionScore ?? '—'}<small>单规则贡献</small></strong>${tag(suspicionHint(a))}</div></div><div class="info-note">${esc(a.ruleName || '视频鉴权失败异常')} · 此处展示单规则的访问异常证据。${f.reason ? esc(reasonText(f.reason)) + '。' : ''}这些结果不能证明内容已下载、解密或传播。</div>
    <button class="button secondary small" data-report-from-alert="${esc(a.id)}">生成取证报告 ↗</button><h3 class="section-title">事件回放</h3><div id="replay-mount"></div><h3 class="section-title">触发时的特征快照</h3><div class="evidence-grid">${featureEntries(f).map(([label, value]) => `<div><span>${label}</span><b>${typeof value === 'number' ? number(value) : value}</b></div>`).join('')}</div><dl class="definition evidence-meta"><dt>原生主体</dt><dd>${esc(entityType(f))} · ${esc(entityId(f))}</dd><dt>关联视频</dt><dd>${esc((f.relatedVideoIds || [a.videoId]).filter(Boolean).map(id => displayId(id, 'VIDEO')).join("、")) || "—"}</dd><dt>规则命中</dt><dd>${esc(a.ruleId || 'R7')} · ${esc(f.tier || scoreLevel(a.anomalyScore))} · ${a.anomalyScore} 分</dd><dt>来源 / 阶段</dt><dd>${esc(a.source)} / ${esc(a.eventType)}</dd><dt>数据类别</dt><dd>${esc(f.datasetKinds.join('、'))}</dd><dt>验证场景</dt><dd class="mono">${esc(a.scenario)}</dd><dt>租户范围</dt><dd class="mono">${esc(a.tenantId)}</dd><dt>生成时间</dt><dd>${timestamp(a.createdAt)}</dd><dt>证据版本</dt><dd class="mono">${esc(a.sqlHash.slice(0, 16))}</dd></dl>
    ${f.configuration ? `<h3 class="section-title">触发时的规则配置</h3><pre class="frozen-config">${esc(JSON.stringify(f.configuration, null, 2))}</pre>` : ''}<h3 class="section-title">人工复核</h3><form id="review-form"><label class="field">复核状态<select name="status">${['复核中', '观察中', '已确认', '已误报'].map(s => `<option ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label class="field">复核依据<textarea name="note" rows="3" maxlength="500" placeholder="例如：已核对该窗口签名配置变更，判断为业务故障，后续持续观察。" required></textarea></label><div class="form-error" id="review-error" role="alert" hidden></div><button type="submit" class="button primary" id="review-submit">保存复核结论</button><span class="inline-hint">保存后同步更新告警列表与总览</span></form>
    <h3 class="section-title">复核记录 <span class="muted">${a.reviews.length}</span></h3>${a.reviews.length ? `<ol class="timeline">${a.reviews.slice().reverse().map(r => `<li><div class="row">${tag(r.status, statusClass(r.status))}<small>${timestamp(r.createdAt)} · ${esc(r.actor)}</small></div><p>${esc(r.note)}</p></li>`).join('')}</ol>` : '<p class="muted">尚无人工复核记录。触发时的评分和证据会一直保留。</p>'}</div>`;
  mountReplay($('#replay-mount'), a, api, { displayId });
}
async function openAlert(id) {
  state.selected = await api('/api/alerts/' + encodeURIComponent(id));
  state.reviewRequest = null;
  renderDetail(state.selected);
  if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  try {
    if (button.dataset.close) { if (!state.detecting && !state.reviewing) $('#' + button.dataset.close).close(); return; }
    if (button.hasAttribute('data-detect')) { $('#detect-error').hidden = true; $('#detect-dialog').showModal(); return; }
    if (button.dataset.nav) { await navigate(button.dataset.nav); return; }
    if (button.dataset.alert) { await openAlert(button.dataset.alert); return; }
    if (button.dataset.run) { openRun(button.dataset.run); return; }
    if (button.hasAttribute('data-refresh')) { await load(); toast('记录已刷新'); return; }
    if (button.hasAttribute('data-filter')) { state.query = $('#alert-search').value; state.status = $('#status-filter').value; state.pageIndex = 1; await loadAlerts(); return; }
    if (button.dataset.page) { state.pageIndex += Number(button.dataset.page); await loadAlerts(); }
  } catch (error) { toast(error.message); }
});
$('#detect-form').addEventListener('change', event => {
  if (event.target.name === 'scenario') {
    const input = $('#detect-form').elements.windowStart;
    input.value = (input.value || '2026-10-23T14:00').slice(0, 11) + ({ unknown_inputs: '17:00', rapid_pull: '12:00', token_shared: '13:00', scope_violation: '15:00', missing_chain: '16:00', client_tool: '18:00', sustained_access: '02:00' }[event.target.value] || '14:00');
  }
});
$('#detect-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.detecting) return;
  state.detecting = true; $('#detect-submit').disabled = true; $('#detect-submit').textContent = '正在读取并检测…'; $('#detect-error').hidden = true;
  try {
    const fields = new FormData(event.target);
    const result = await api('/api/detections', Object.fromEntries(fields));
    $('#detect-dialog').close();
    await load();
    toast(result.reused ? '已复用该窗口的检测记录，复核状态保持不变' : result.run.alertCount ? `检测完成，生成 ${result.run.alertCount} 条告警` : result.run.features.some(f => f.labelHit) ? '检测完成，命中夜间标签（0 分），不生成告警；各规则状态见检测结果' : result.run.features.some(f => f.computeStatus === 'UNAVAILABLE') ? '检测完成，部分规则数据不足，未生成告警' : result.run.features.length ? '检测完成，该窗口没有可计分命中' : '该窗口未观察到事件，不能据此确认安全');
  } catch (error) { $('#detect-error').textContent = error.message; $('#detect-error').hidden = false; await load().catch(() => {}); }
  finally { state.detecting = false; $('#detect-submit').disabled = false; $('#detect-submit').textContent = '开始检测 →'; }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'review-form') return;
  event.preventDefault(); if (state.reviewing) return;
  const fields = Object.fromEntries(new FormData(event.target));
  const key = JSON.stringify([state.selected.id, fields]);
  if (state.reviewRequest?.key !== key) state.reviewRequest = { key, id: crypto.randomUUID() };
  state.reviewing = true; $('#review-submit').disabled = true; $('#review-error').hidden = true;
  try {
    state.selected = await api(`/api/alerts/${state.selected.id}/reviews`, { ...fields, requestId: state.reviewRequest.id, expectedVersion: state.selected.version });
    renderDetail(state.selected); await load(); toast('复核结论已保存'); state.reviewRequest = null;
  } catch (error) { $('#review-error').textContent = error.message; $('#review-error').hidden = false; }
  finally { state.reviewing = false; if ($('#review-submit')) $('#review-submit').disabled = false; }
});
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('cancel', event => { if (state.detecting || state.reviewing) event.preventDefault(); });
document.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.id === 'alert-search') { event.preventDefault(); document.querySelector('[data-filter]').click(); } });
window.addEventListener('hashchange', () => { const page = location.hash.slice(1); if (page && (page.split('/')[0] !== state.page || state.page==='reports')) navigate(page).catch(e => toast(e.message)); });
installRuleEditor({ api, getRules: () => state.rules, onReload: load, onRender: render, onToast: toast });
installReports({api,onToast:toast,onNavigate:navigate,onRender:render});
state.page = ['overview', 'alerts', 'rule','reports'].includes(location.hash.slice(1).split('/')[0]) ? location.hash.slice(1).split('/')[0] : 'overview';
load().catch(error => { $('#app').innerHTML = `<div class="empty"><h2>工作空间连接失败</h2><p>${esc(error.message)}</p><button class="button secondary" data-refresh>重新连接</button></div>`; });
setInterval(() => { if (state.page === 'overview' && !document.querySelector('dialog[open]')) load().catch(() => {}); }, 5000);
