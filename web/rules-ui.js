const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const copy = value => JSON.parse(JSON.stringify(value));
const ui = { selected: 'R7', draft: null, baseRevision: 1, dirty: false, busy: false, history: [], result: null, note: '调整候选规则配置', sample: {}, pendingRequest: null };
let context;
const getRule = () => context.getRules().find(r => r.id === ui.selected);
const samples = { R1: { missingOneSegments: 120, missingTokenKeySegments: 100 }, R2: { contentSeconds: 7200, speedRatio: 12 }, R3: { concurrentVideos: 4 }, R4A: { outsideAttempts: 30, outsideVideos: 5, outsideSuccesses: 1 }, R4B: { generalEnvironments: 2, attentionEnvironments: 2, attentionPairs: 1, highPairs: 1 }, R5: { ipCount: 8, uaCount: 4 }, R6: { uniqueSegments: 196, coverage: .98, monotonic: .995, intervalCv: .06 }, R7: { known: 200, failed: 150, failureRatio: .75 }, R8: { activeMinutes: 960, contentSeconds: 57600 }, R9: { nightEvents: 5 }, R10: { toolRequests: 126, toolStages: 3 } };
const groups = tier => [tier.conditions, ...(tier.alternatives || [])];
const display = (value, f) => f.unit === '%' ? Number((value * 100).toFixed(5)) : value;
function loadDraft(rule) {
  ui.draft = rule.configuration ? copy(rule.configuration) : null;
  ui.baseRevision = rule.configuration?.revision || 1;
  ui.dirty = false; ui.result = null; ui.history = []; ui.note = '调整候选规则配置'; ui.sample = copy(samples[rule.id] || {}); ui.pendingRequest = null;
}
const preview = () => !ui.draft ? '' : ui.draft.id === 'R9'
  ? `北京时间 ${ui.draft.parameters.nightStartHour}:00 — ${ui.draft.parameters.nightEndHour}:00\n标签分值固定 0，不生成风险告警`
  : ui.draft.tiers.map(t => `${t.label} → ${t.score} 分\n  ${groups(t).map(g => g.map(c => `${getRule().fields.find(f => f.key === c.field).label} ${c.op} ${display(c.value, getRule().fields.find(f => f.key === c.field))}${getRule().fields.find(f => f.key === c.field).unit}`).join(' 且 ')).join('\n  或 ')} `).join('\n\n');

function renderTier(tier, i, rule) {
  return `<div class="configuration-tier"><div class="tier-heading"><b>${tier.label}档</b><label>分值 <input type="number" data-rule-score="${i}" value="${tier.score}" min="1" max="${rule.maxScore}" step="1"></label></div>${groups(tier).map((group, branch) => `${branch ? '<p class="branch-or">或满足以下条件</p>' : ''}${group.map((c, j) => { const f = rule.fields.find(f => f.key === c.field); return `<label class="threshold-field"><span>${f.label}</span><span class="operator-symbol">${c.op === '>=' ? '≥' : '≤'}</span><input type="number" data-rule-condition="${i}:${branch}:${j}" value="${display(c.value, f)}" min="0" max="${display(f.max, f)}" step="${f.integer ? 1 : .01}" aria-label="${tier.label}档 ${f.label}"><span>${f.unit}</span></label>`; }).join('')}`).join('')}<p class="inline-hint">每组内条件同时满足；不同组满足任一组即可，规则只取最高档。</p></div>`;
}

export function renderRulesPage(rules) {
  if (!context) return '';
  const rule = rules.find(r => r.id === ui.selected) || rules[0];
  if (!ui.draft && rule.supported) loadDraft(rule);
  const enabled = rules.filter(r => r.configuration?.enabled).length;
  return `<div class="page-heading"><div><div class="eyebrow">CONTENT SECURITY / RULE CONFIGURATION</div><h1>规则配置</h1><p>${rules.filter(r => r.supported).length} 条已接入 · ${enabled} 条已启用 · 修改配置后对新检测生效</p></div><button class="button secondary" data-rule-action="reload">重新载入</button></div>
    <div class="rules-layout"><aside class="card rule-menu">${rules.map(r => `<button data-rule-select="${r.id}" class="${r.id === rule.id ? 'selected' : ''}"><span class="mono">${r.id}</span><span>${escape(r.name)}<small>${r.window}</small></span><i class="rule-state ${!r.supported ? 'unavailable' : r.configuration.enabled ? 'enabled' : ''}">${!r.supported ? '待接入' : r.configuration.enabled ? '启用' : '停用'}</i></button>`).join('')}</aside>
    ${!rule.supported ? `<section class="card unavailable-rule"><span class="rule-icon">${rule.id}</span><h2>${escape(rule.name)}</h2><p>${escape(rule.description)}</p><div class="info-note">${escape(rule.reason)}</div><p class="muted">所需数据或字段接入前，该规则不能启用，检测时也不会使用估算值代替。</p></section>` : `<div class="rule-editor-column"><section class="card rule-editor"><div class="row"><span class="rule-icon">${rule.id}</span><div><h2>${escape(rule.name)}</h2><p class="muted">当前 ${escape(rule.configuration.version)} · ${rule.window} · ${rule.kind}规则</p></div></div><p class="rule-description">${escape(rule.description)}</p><div class="info-note">${escape(rule.prerequisite)}</div>
    <label class="enable-switch"><input type="checkbox" id="config-enabled" ${ui.draft.enabled ? 'checked' : ''}> 启用本规则<span class="muted">停用后不参与新的检测</span></label>
    ${rule.parameters.map(f => `<label class="field">${f.label}（${f.unit}）<input type="number" data-rule-parameter="${f.key}" value="${ui.draft.parameters[f.key]}" min="0" max="${f.max}" step="${f.integer ? 1 : .01}"></label>`).join('')}
    ${ui.draft.tiers.map((tier, i) => renderTier(tier, i, rule)).join('')}
    <label class="field">变更说明<input id="config-note" value="${escape(ui.note)}" maxlength="200"></label><div id="config-message" class="config-message" role="status">${ui.dirty ? '草稿已修改，尚未保存' : '正在使用已保存配置'}</div><div class="configuration-actions"><button class="button secondary" data-rule-action="defaults">推荐阈值</button><button class="button secondary" data-rule-action="validate">校验配置</button><button id="config-save" class="button primary" data-rule-action="save" ${ui.busy || !ui.dirty ? 'disabled' : ''}>保存并生效</button></div></section>
    <section class="card history-card"><div class="card-heading"><div><h2>版本记录</h2><p>载入旧版后保存会产生新版本，历史告警保持原配置。</p></div><button class="text-link" data-rule-action="history">读取版本记录 ↻</button></div><div class="history-list">${ui.history.length ? ui.history.map(h => `<div class="configuration-history"><div><b>${escape(h.configuration.version)}</b><span>${h.configuration.enabled ? '启用' : '停用'}</span><p>${escape(h.note)}</p><small>${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(h.createdAt))}</small></div><button class="button secondary small" data-rule-version="${h.configuration.revision}">载入此版本</button></div>`).join('') : '<p class="muted">点击读取版本记录，查看保存和恢复历史。</p>'}</div></section></div>
    <aside class="rule-preview"><section class="card"><div class="card-heading"><div><h2>样例试算</h2><p>仅核对条件，不创建告警</p></div></div><div class="preview-body"><div class="sample-note">假设数据质量前提成立。试算不替代真实数据检测。</div>${[...rule.fields, ...(rule.id === 'R7' ? [{ key: 'known', label: '已知结果 N', unit: '条', max: 1e9, integer: true }] : [])].map(f => `<label class="sample-field"><span>${f.label}${f.unit ? `（${f.unit}）` : ''}</span><input type="number" data-rule-sample="${f.key}" value="${display(ui.sample[f.key] ?? 0, f)}" min="0" max="${display(f.max, f)}" step="${f.integer ? 1 : .01}"></label>`).join('')}<button class="button primary full" data-rule-action="simulate">运行样例试算 →</button><div id="sample-result" class="sample-result" ${ui.result ? '' : 'hidden'}>${ui.result ? escape(ui.result) : ''}</div></div></section><section class="card"><div class="card-heading"><h2>条件预览</h2></div><pre class="configuration-preview" id="config-preview">${escape(preview())}</pre></section></aside>`}</div>`;
}

function changed() {
  ui.dirty = true; ui.result = null;
  const save = document.querySelector('#config-save'); if (save) save.disabled = ui.busy;
  const result = document.querySelector('#sample-result'); if (result) result.hidden = true;
  const message = document.querySelector('#config-message'); if (message) { message.textContent = '草稿已修改，尚未保存'; message.className = 'config-message'; }
  const pre = document.querySelector('#config-preview'); if (pre) pre.textContent = preview();
}
export function installRuleEditor(callbacks) {
  context = callbacks;
  document.addEventListener('input', event => {
    const el = event.target;
    if (!ui.draft) return;
    const rule = getRule();
    if (el.dataset.ruleCondition) {
      const [i, branch, j] = el.dataset.ruleCondition.split(':').map(Number); const c = groups(ui.draft.tiers[i])[branch][j]; const f = rule.fields.find(f => f.key === c.field);
      c.value = el.value === '' ? null : Number(el.value) / (f.unit === '%' ? 100 : 1); changed();
    } else if (el.dataset.ruleScore !== undefined) { ui.draft.tiers[Number(el.dataset.ruleScore)].score = el.value === '' ? null : Number(el.value); changed(); }
    else if (el.dataset.ruleParameter) { ui.draft.parameters[el.dataset.ruleParameter] = el.value === '' ? null : Number(el.value); changed(); }
    else if (el.id === 'config-enabled') { ui.draft.enabled = el.checked; changed(); }
    else if (el.id === 'config-note') { ui.note = el.value; changed(); }
    else if (el.dataset.ruleSample) {
      const f = rule.fields.find(f => f.key === el.dataset.ruleSample);
      ui.sample[el.dataset.ruleSample] = el.value === '' ? null : Number(el.value) / (f?.unit === '%' ? 100 : 1);
      ui.result = null; const panel = document.querySelector('#sample-result'); if (panel) panel.hidden = true;
    }
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button || ui.busy) return;
    if (button.dataset.ruleSelect) { ui.selected = button.dataset.ruleSelect; loadDraft(getRule()); context.onRender(); return; }
    if (button.dataset.ruleVersion) {
      const selected = ui.history.find(h => h.configuration.revision === Number(button.dataset.ruleVersion));
      ui.draft = copy(selected.configuration); ui.note = `从第 ${selected.configuration.revision} 版恢复`; ui.dirty = true; ui.result = null; context.onRender(); return;
    }
    const action = button.dataset.ruleAction; if (!action) return;
    ui.busy = true; button.disabled = true;
    try {
      const id = ui.selected;
      if (action === 'reload') { await context.onReload(); loadDraft(getRule()); context.onRender(); return; }
      if (action === 'defaults') { const enabled = ui.draft.enabled; ui.draft = copy(getRule().defaults); ui.draft.enabled = enabled; ui.dirty = true; ui.result = null; context.onRender(); return; }
      if (action === 'history') { ui.history = await context.api(`/api/rules/${id}/history`); context.onRender(); return; }
      if (action === 'validate') {
        await context.api(`/api/rules/${id}/validate`, { configuration: ui.draft });
        const panel = document.querySelector('#config-message'); panel.textContent = '配置校验通过；保存后用于新的检测'; panel.className = 'config-message success';
      }
      if (action === 'simulate') {
        const result = await context.api(`/api/rules/${id}/simulate`, { configuration: ui.draft, metrics: ui.sample });
        const reason = ({ BUSINESS_DOWNLOAD_POLICY_UNVERIFIED: '合法下载或预取策略尚待核实，嫌疑分暂不可计算', BUSINESS_CACHE_POLICY_UNVERIFIED: '合法缓存策略尚待核实，嫌疑分暂不可计算', BUSINESS_SHARING_POLICY_UNVERIFIED: '合法共享或多路策略尚待核实，嫌疑分暂不可计算', RULE_DISABLED: '本规则尚未启用', INSUFFICIENT_KNOWN_RESULTS: '已知结果样本不足', MISSING_REQUIRED_FEATURE: '缺少必要的样例特征' })[result.reason] || result.reason;
        ui.result = `${result.tier} · A ${result.anomalyScore ?? '—'} / S ${result.suspicionScore ?? '—'}${reason ? `\n${reason}` : ''}\n${result.note}`;
        const panel = document.querySelector('#sample-result'); panel.textContent = ui.result; panel.hidden = false;
      }
      if (action === 'save') {
        const requestKey = JSON.stringify([id, ui.draft, ui.baseRevision, ui.note]);
        if (ui.pendingRequest?.key !== requestKey) ui.pendingRequest = { key: requestKey, id: crypto.randomUUID() };
        const result = await context.api(`/api/rules/${id}/configurations`, { configuration: ui.draft, expectedRevision: ui.baseRevision, requestId: ui.pendingRequest.id, note: ui.note });
        ui.dirty = false; await context.onReload(); loadDraft(getRule()); ui.history = await context.api(`/api/rules/${id}/history`); context.onRender(); context.onToast(`已保存 ${result.version}，历史告警未改写`);
      }
    } catch (error) {
      const panel = document.querySelector('#config-message');
      if (panel) { panel.textContent = error.message; panel.className = 'config-message error-text'; } else context.onToast(error.message);
    } finally { ui.busy = false; if (button.isConnected) button.disabled = false; const save = document.querySelector('#config-save'); if (save) save.disabled = !ui.dirty; }
  });
}
