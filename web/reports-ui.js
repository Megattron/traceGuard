const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time = v => v ? new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(v)) : '—';
const kind = t => ({VIEWER:'认证观众',CREDENTIAL_VIEWER:'凭证绑定观众（身份未核实）',TOKEN:'授权凭证',VIDEO:'视频主体'})[t] || t;
const chip = (text,css='') => `<span class="report-chip ${css}">${esc(text)}</span>`;
let api, toast, navigate, onRender;
const state = {list:[], report:null, config:{}, loading:false, busy:false, candidates:[], seed:[], operation:null, request:null, error:''};
const refs = ids => ids.map(id=>`<a class="evidence-ref" href="#evidence-${esc(id)}" data-evidence="${esc(id)}">${esc(id)}</a>`).join(' ');
const items = list => list.length ? `<ul class="report-findings">${list.map(item=>`<li>${esc(item.text)} ${refs(item.evidenceIds)}</li>`).join('')}</ul>` : '<p class="report-muted">本项暂无补充。</p>';
function modelContent(content) {
  return `<p class="model-summary">${esc(content.summary.text)} ${refs(content.summary.evidenceIds)}</p><details class="model-explanation"><summary>展开研判依据与建议</summary>${[['证据解读',content.findings],['其他可能解释',content.alternativeExplanations],['尚待核实',content.unknowns],['建议补查',content.recommendedChecks]].map(([title,list])=>`<h4>${title}</h4>${items(list)}`).join('')}</details>`;
}
function formatMetric(m) { return m.value===null ? '未记录' : (m.unit==='%' ? (m.value*100).toLocaleString('zh-CN',{maximumFractionDigits:2})+'%' : m.value.toLocaleString('zh-CN',{maximumFractionDigits:4})+(m.unit?' '+m.unit:'')); }
function paper(report) {
  const p=report.payload, run=p.snapshot.run;
  const adopted=(report.analyses||[]).find(a=>a.review?.decision==='ADOPTED'&&a.verified&&report.integrity.verified);
  const reviewed=p.snapshot.alerts.filter(a=>a.reviews.length);
  const pending=p.snapshot.alerts.filter(a=>!['已确认','已误报'].includes(a.status)).length;
  const subjects=[...new Map(p.facts.map(f=>[f.subject.type+'|'+f.subject.id,f.subject])).values()];
  const checks=p.assessment.checks.filter(c=>!c.text.startsWith('人工核查后')).slice(0,3);
  const synthetic=p.facts.every(f=>f.datasetKinds.length&&f.datasetKinds.every(k=>['SYNTHETIC','FIXTURE','LOCAL_DEMO'].includes(k)));
  const conclusion='观察到'+[...new Set(p.facts.map(f=>f.ruleName))].join('、')+'特征。'+(p.facts.some(f=>f.suspicionScore===null)?'相关业务授权前提尚未核实，盗版嫌疑待核查。':'需结合业务授权与人工复核确认原因。');
  const detailFacts=p.facts.map(f=>[
    '<section class="fact-block"><div class="fact-heading"><b>'+esc(f.id)+' · '+esc(f.ruleId)+' · '+esc(f.ruleName)+'</b></div>',
    '<div class="fact-metrics">'+f.metrics.map(m=>'<div><small>'+esc(m.label)+'</small><b>'+esc(formatMetric(m))+'</b></div>').join('')+'</div>',
    '<dl class="report-meta compact"><dt>告警 / 版本</dt><dd>'+esc(f.alertId)+' · '+esc(f.ruleVersion)+' · '+esc(f.tier)+'</dd>',
    '<dt>原生主体</dt><dd>'+esc(kind(f.subject.type))+' · '+esc(f.subject.id)+'</dd><dt>关联视频</dt><dd>'+esc(f.relatedVideoIds.join('、')||'未记录')+'</dd>',
    '<dt>实际窗口</dt><dd>'+esc(f.windowStart)+' — '+esc(f.windowEnd)+'</dd><dt>来源 / 类别</dt><dd>'+esc(f.source)+' / '+esc(f.eventType)+' · '+esc(f.datasetKinds.join('、'))+'</dd>',
    '<dt>命中条件</dt><dd>'+f.thresholds.map(esc).join(' 或 ')+'</dd><dt>事件引用</dt><dd>'+(f.evidenceRefs.length?'<pre>'+esc(f.evidenceRefs.join('\n'))+'</pre>':'历史快照未保存事件级引用')+'</dd></dl>',
    f.limitations.length?'<div class="fact-limit">'+f.limitations.map(t=>'<p>'+esc(t)+'</p>').join('')+'</div>':'',
    '</section>'
  ].join('')).join('');
  return [
    '<article class="report-paper concise-report" id="report-paper" aria-label="取证报告正文">',
    '<header class="paper-title"><h2>视频访问风险取证报告</h2><p><span class="mono">'+esc(p.id)+'</span> · v'+p.revision+' · '+time(p.createdAt)+'</p><div>'+chip(synthetic?'合成验证数据':'风险事件快照',synthetic?'amber':'')+chip(report.archive?'已归档':'待归档')+'</div></header>',
    '<section class="paper-section report-conclusion"><h3>研判结论 '+chip(adopted?'模型意见 · 已人工采用':'规则生成')+'</h3><p>'+esc(adopted?adopted.content.summary.text:conclusion)+'</p>',
    adopted?'<p class="report-caption">审核依据：'+esc(adopted.review.note)+'</p>':'',
    '<p class="report-caption">'+(pending?pending+' 项告警仍待人工核查':'所选告警均已完成复核')+' · '+(p.facts.some(f=>f.suspicionScore===null)?'部分嫌疑前提待核实':'嫌疑贡献见下表')+' · 各规则分数不相加</p></section>',
    '<section class="paper-section"><h3>关键依据</h3><div class="report-subjects">'+subjects.map(s=>'<span>'+esc(kind(s.type))+' <code>'+esc(s.id)+'</code></span>').join('')+'</div>',
    '<div class="table-scroll"><table class="report-table conclusion-table"><thead><tr><th>规则</th><th>事实结论</th><th>异常分 / 嫌疑分</th></tr></thead><tbody>',
    p.facts.map(f=>'<tr id="evidence-'+esc(f.id)+'"><td><b>'+esc(f.ruleId)+'</b><small>'+esc(f.ruleName)+'</small></td><td>'+esc(f.conclusion)+'</td><td>'+f.anomalyScore+' / '+(f.suspicionScore??'待核实')+'</td></tr>').join(''),
    '</tbody></table></div><p class="report-caption">'+esc(run.windowStart)+' — '+esc(run.windowEnd)+' · 北京时间</p></section>',
    checks.length?'<section class="paper-section"><h3>下一步核查</h3>'+items(checks)+'</section>':'',
    reviewed.length?'<section class="paper-section"><h3>人工复核结论</h3>'+reviewed.map(a=>'<p class="concise-review"><b>'+esc(a.ruleId)+' · '+esc(a.status)+'</b> '+esc(a.reviews.at(-1).note)+'</p>').join('')+'</section>':'',
    report.archive?'<div class="archive-stamp"><b>已归档 · '+time(report.archive.archivedAt)+'</b><p>'+esc(report.archive.note)+'</p></div>':'',
    '<details class="report-details"><summary>查看完整证据与留存信息</summary><div class="report-detail-body">',
    '<dl class="report-meta"><dt>租户 / 场景</dt><dd>'+esc(p.tenantId)+' / '+esc(run.scenario)+'</dd><dt>检测运行</dt><dd class="mono">'+esc(run.id)+'</dd><dt>数据批次</dt><dd>'+esc(run.dataBatchId||'历史记录未保存批次标识')+'</dd></dl>',
    detailFacts,
    '<h4>其他解释与未核实前提</h4>'+items(p.assessment.alternatives)+items(p.assessment.unknowns),
    '<h4>完整复核记录</h4>'+p.snapshot.alerts.map(a=>'<div class="report-review"><b>'+esc(a.id)+' · '+esc(a.status)+'</b>'+(a.reviews.length?a.reviews.map(r=>'<p>'+esc(r.note)+'</p><small>'+time(r.createdAt)+' · '+esc(r.actor)+' · '+esc(r.status)+'</small>').join(''):'<p class="report-muted">尚无人工复核记录。</p>')+'</div>').join(''),
    adopted?'<h4>已采用的模型研判</h4><p class="report-caption">'+esc(adopted.model)+' · '+esc(adopted.promptVersion)+' · '+time(adopted.completedAt)+'</p>'+modelContent(adopted.content)+'<p class="report-hash">模型内容 SHA-256 '+esc(adopted.outputHash)+'</p>':'',
    '<h4>留存与校验</h4><ul class="report-boundaries">'+p.assessment.boundaries.map(t=>'<li>'+esc(t)+'</li>').join('')+'</ul><dl class="report-meta"><dt>正文校验</dt><dd>'+(report.integrity.verified?'SHA-256 一致':'校验失败，请停止使用本版本')+'</dd><dt>正文摘要</dt><dd class="report-hash">'+esc(report.integrity.hash)+'</dd><dt>报告模板</dt><dd>'+esc(p.templateVersion)+'</dd></dl><p class="report-caption">正文摘要对应证据 JSON；模型附录和归档信息单独留存。</p>',
    '</div></details><div class="paper-footer">内部核查材料 · 访问异常不能直接认定侵权</div></article>'
  ].join('');
}
function modelPanel(report) {
  const analyses=report.analyses||[], generating=analyses.some(a=>a.status==='GENERATING');
  const status=a=>a.status==='FAILED'?'生成失败':a.status==='GENERATING'?'生成中':a.review?.decision==='ADOPTED'?'已人工采用':a.review?.decision==='REJECTED'?'未采用':'待人工审核';
  const draft=a=>[
    '<div class="model-draft"><div class="row">'+chip(status(a),a.status==='FAILED'?'amber':'')+'<small>'+time(a.completedAt||a.createdAt)+'</small></div>',
    a.content?modelContent(a.content):'<p class="report-muted">'+esc(a.error||'请求已提交，稍后刷新查看结果。')+'</p>',
    a.review?'<p class="model-review-note">审核依据：'+esc(a.review.note)+'</p>':a.status==='SUCCEEDED'&&a.verified&&report.integrity.verified&&!report.archive?'<div class="row model-review-actions"><button class="button primary small" data-model-review="'+esc(a.id)+'" data-decision="ADOPTED">采用为报告结论</button><button class="button secondary small" data-model-review="'+esc(a.id)+'" data-decision="REJECTED">不采用</button></div>':'',
    '<details class="model-provenance"><summary>来源与校验信息</summary><dl class="report-meta compact"><dt>模型 / 版本</dt><dd>'+esc(a.model)+' · '+esc(a.promptVersion)+'</dd><dt>输入摘要</dt><dd class="report-hash">'+esc(a.inputHash)+'</dd><dt>输出摘要</dt><dd class="report-hash">'+esc(a.outputHash||'尚未生成')+'</dd><dt>用量</dt><dd>'+(a.usage?'输入 '+a.usage.inputTokens+' / 输出 '+a.usage.outputTokens+' tokens':'未记录')+'</dd></dl></details></div>'
  ].join('');
  return [
    '<section class="model-panel"><div class="model-panel-heading"><div><h2>模型辅助结论</h2><p>'+(state.config.configured?esc(state.config.model):'未配置模型服务')+' · 人工采用后进入报告</p></div><button class="button primary small" data-model-generate '+(!state.config.configured||state.busy||generating||report.archive||!report.integrity.verified?'disabled':'')+'>'+(state.busy||generating?'研判中…':'生成模型研判')+'</button></div>',
    state.error?'<p class="form-error" role="alert">'+esc(state.error)+'</p>':'',
    analyses.length?draft(analyses[0]):'<div class="model-empty">暂无模型意见，可先使用规则报告。</div>',
    analyses.length>1?'<details class="model-history"><summary>历史研判（'+(analyses.length-1)+'）</summary>'+analyses.slice(1).map(a=>'<details class="model-history"><summary>'+time(a.completedAt||a.createdAt)+' · '+status(a)+'</summary>'+draft(a)+'</details>').join('')+'</details>':'',
    '<details class="model-provenance"><summary>调用说明与记录下载</summary><p class="report-caption">仅发送脱敏数值特征与主体别名，模型意见不改变规则评分。</p><div class="row"><a class="text-link" href="/api/reports/'+report.payload.id+'/analyses" download>下载研判记录</a><a class="text-link" href="/api/reports/'+report.payload.id+'/llm-context" download>查看脱敏输入</a></div></details></section>'
  ].join('');
}
export function renderReportsPage() {
  const r=state.report;
  return `<div class="page-heading"><div><div class="eyebrow">CONTENT SECURITY / EVIDENCE</div><h1>取证报告</h1><p>冻结告警证据 · 模型辅助研判 · 人工审核留存</p></div><button class="button primary" data-report-create>＋ 生成取证报告</button></div>
    ${state.list.length?`<div class="report-picker"><label>已保存报告<select id="report-select" aria-label="选择已保存报告">${state.list.map(p=>`<option value="${p.id}" ${r?.payload.id===p.id?'selected':''}>${esc(p.id)} · v${p.revision} · ${esc(p.ruleIds.join('/'))} · ${p.archivedAt?'已归档':'待归档'}</option>`).join('')}</select></label><span class="report-caption">已保存 ${state.list.length} 份 · 同一快照重复生成会复用</span><button class="text-link" data-report-refresh>刷新 ↻</button></div>`:''}
    ${r?`<div class="report-toolbar"><div>${chip(r.integrity.verified?'正文校验一致':'正文校验失败',r.integrity.verified?'green':'amber')}<span class="report-caption">${r.archive?'此版本已归档':'待人工核查后归档'}</span></div><div class="row"><button class="button secondary small" data-report-model>模型研判 ↓</button><button class="button secondary small" data-report-verify>校验摘要</button><a class="button secondary small ${r.integrity.verified?'':'disabled'}" href="/api/reports/${r.payload.id}/evidence" download>下载证据 JSON</a><button class="button secondary small" data-report-print ${!r.integrity.verified?'disabled':''}>打印 / 保存 PDF</button><button class="button primary small" data-report-archive ${r.archive||state.busy||r.analyses?.some(a=>a.status==='GENERATING')||!r.integrity.verified?'disabled':''}>${r.archive?'已归档':'标记归档'}</button></div></div>${paper(r)}${modelPanel(r)}`:state.loading?'<div class="loading">正在读取报告…</div>':'<section class="card empty"><div class="empty-icon">▤</div><h3>把风险事件整理为可核查的报告</h3><p>从同一次检测选取告警，冻结特征、规则版本及人工复核记录。报告生成后可继续请求模型辅助研判。</p><button class="button secondary" data-report-create>选择告警生成 →</button></section>'}`;
}
export async function loadReports(id) {
  const [list,config]=await Promise.all([api('/api/reports'),api('/api/reports/config')]);state.list=list;state.config=config;
  const selected=id||location.hash.split('/')[1]||state.report?.payload.id||list[0]?.id;
  state.report=selected?await api('/api/reports/'+encodeURIComponent(selected)):null;onRender();
}
async function composer(seedIds=[]) {
  state.seed=seedIds; const result=await api('/api/reports/candidates');state.candidates=result.items;
  for(const id of seedIds)if(!state.candidates.some(a=>a.id===id)) {const a=await api('/api/alerts/'+id);state.candidates.push({...a,subject:{type:a.feature.subjectType||'VIDEO',id:a.feature.subjectId||a.videoId}});}
  const runs=[...new Set(state.candidates.map(a=>a.runId))], selected=state.candidates.find(a=>seedIds.includes(a.id))?.runId||runs[0];
  $('#report-compose-content').innerHTML=`<form id="report-compose-form"><div class="dialog-heading"><div><span class="eyebrow">NEW EVIDENCE REPORT</span><h2 id="report-compose-title">选择风险事件</h2></div><button type="button" class="icon-button" data-close="report-compose-dialog" aria-label="关闭报告生成面板">×</button></div><div class="dialog-body"><p class="muted">同一报告选择同一次检测的 1～8 条告警，保留各自主体和分值。</p>${runs.length?`<label class="field">检测运行<select name="runId" id="report-run">${runs.map(id=>{const a=state.candidates.find(a=>a.runId===id);return `<option value="${esc(id)}" ${id===selected?'selected':''}>${esc(a.scenario)} · ${esc(a.windowStart)} · ${esc(id.slice(-10))}</option>`;}).join('')}</select></label><div id="report-candidates"></div>`:'<div class="info-note">暂无可用告警，请先运行检测。</div>'}<div class="form-error" id="report-compose-error" role="alert" hidden></div></div><div class="dialog-actions"><button type="button" class="button secondary" data-close="report-compose-dialog">取消</button><button type="submit" class="button primary" ${!runs.length?'disabled':''}>冻结证据并生成</button></div></form>`;
  drawCandidates(selected);$('#detail-dialog').close();$('#report-compose-dialog').showModal();
}
function drawCandidates(runId) {
  if(!$('#report-candidates'))return;
  const candidates=state.candidates.filter(a=>a.runId===runId);
  $('#report-candidates').innerHTML=candidates.map((a,i)=>`<label class="report-candidate"><input type="checkbox" name="alertIds" value="${esc(a.id)}" ${state.seed.length?state.seed.includes(a.id)?'checked':'':i<8?'checked':''}><span><b>${esc(a.ruleId)} · ${esc(a.ruleName)}</b><small>${esc(kind(a.subject.type))} · <span class="mono">${esc(a.subject.id)}</span></small><small>${esc(a.id)} · ${esc(a.status)}</small></span><em>A ${a.anomalyScore}<small>S ${a.suspicionScore??'待核实'}</small></em></label>`).join('');
}
function operationDialog(operation) {
  state.operation=operation; state.request=null;
  const archive=operation.type==='archive';
  $('#report-action-content').innerHTML=`<form id="report-action-form"><div class="dialog-heading"><h2 id="report-action-title">${archive?'标记报告归档':operation.decision==='ADOPTED'?'采用模型研判':'不采用模型研判'}</h2><button type="button" class="icon-button" data-close="report-action-dialog" aria-label="关闭操作面板">×</button></div><div class="dialog-body"><div class="info-note">${archive?'归档后锁定本版本的模型生成与审核。归档是本地留存标记，请确认正文和已采用附录均已核查。':'请核对证据引用及业务例外。采用后将摘要用作报告结论，原告警评分与复核状态保持独立。'}</div><label class="field">${archive?'归档说明':'审核依据'}<textarea name="note" rows="4" maxlength="500" required placeholder="填写已核验内容、判断依据及仍存疑点"></textarea></label><div class="form-error" id="report-action-error" role="alert" hidden></div></div><div class="dialog-actions"><button type="button" class="button secondary" data-close="report-action-dialog">取消</button><button type="submit" class="button primary">${archive?'确认归档':'保存审核'}</button></div></form>`;
  $('#report-action-dialog').showModal();
}
export function installReports(options) {
  ({api,onToast:toast,onNavigate:navigate,onRender}=options);
  document.addEventListener('change',async event=>{try {
    if(event.target.id==='report-select')await navigate('reports/'+event.target.value);
    if(event.target.id==='report-run')drawCandidates(event.target.value);
  }catch(e){toast(e.message);}});
  document.addEventListener('click',async event=>{
    const ref=event.target.closest('[data-evidence]');if(ref){event.preventDefault();$('#evidence-'+ref.dataset.evidence)?.scrollIntoView({behavior:'smooth',block:'center'});return;}
    const b=event.target.closest('button');if(!b||b.disabled)return;
    try {
      if(b.hasAttribute('data-report-create'))await composer();
      if(b.dataset.reportFromAlert)await composer([b.dataset.reportFromAlert]);
      if(b.hasAttribute('data-report-refresh'))await loadReports();
      if(b.hasAttribute('data-report-print'))window.print();
      if(b.hasAttribute('data-report-model'))$('.model-panel')?.scrollIntoView({behavior:'smooth',block:'start'});
      if(b.hasAttribute('data-report-verify')) {const v=await api('/api/reports/'+state.report.payload.id+'/verify');await loadReports();toast(v.verified?'正文摘要校验一致 · '+time(v.checkedAt):'校验失败，请停止使用本版本');}
      if(b.hasAttribute('data-report-archive'))operationDialog({type:'archive'});
      if(b.dataset.modelReview)operationDialog({type:'review',id:b.dataset.modelReview,decision:b.dataset.decision});
      if(b.hasAttribute('data-model-generate')) {
        if(state.busy)return;state.busy=true;state.error='';const id=state.report.payload.id;const requestId=state.modelRequest?.reportId===id?state.modelRequest.id:crypto.randomUUID();state.modelRequest={reportId:id,id:requestId};onRender();
        try {const r=await api('/api/reports/'+id+'/analyze',{expectedHash:state.report.integrity.hash,requestId});if(state.report?.payload.id===id)state.report=r;state.modelRequest=null;toast(r.analyses[0]?.status==='SUCCEEDED'?'模型草稿已生成，等待人工审核':r.analyses[0]?.error||'模型请求进行中');}
        catch(e){state.error=e.message;toast(e.message);}finally{state.busy=false;onRender();}
      }
    }catch(e){toast(e.message);}
  });
  document.addEventListener('submit',async event=>{
    const form=event.target;if(!['report-compose-form','report-action-form'].includes(form.id))return;event.preventDefault();
    const submit=form.querySelector('[type=submit]');if(submit.disabled)return;submit.disabled=true;
    const error=$('#'+(form.id==='report-compose-form'?'report-compose-error':'report-action-error'));error.hidden=true;
    try {
      if(form.id==='report-compose-form') {const ids=new FormData(form).getAll('alertIds');const result=await api('/api/reports',{alertIds:ids});$('#report-compose-dialog').close();state.report=result.report;await navigate('reports/'+result.report.payload.id);toast(result.reused?'已复用相同证据快照的报告':'报告已生成，证据快照已留存');}
      else {const note=new FormData(form).get('note'),op=state.operation,key=JSON.stringify([op,note]);if(state.request?.key!==key)state.request={key,id:crypto.randomUUID()};const path='/api/reports/'+state.report.payload.id+(op.type==='archive'?'/archive':'/analyses/'+op.id+'/review');state.report=await api(path,{note,expectedHash:state.report.integrity.hash,requestId:state.request.id,...(op.type==='review'?{decision:op.decision}:{})});$('#report-action-dialog').close();await loadReports();toast(op.type==='archive'?'报告已归档':'研判审核已保存');}
    }catch(e){error.textContent=e.message;error.hidden=false;}finally{submit.disabled=false;}
  });
}
