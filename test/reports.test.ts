import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { canonicalJSON, llmContext, sha256 } from '../server/reports.ts';
import { ModelClient, validateModelContent, PROMPT_VERSION } from '../server/model.ts';
import type { Config } from '../server/config.ts';

const cfg=(path=':memory:'):Config=>({host:'127.0.0.1',port:0,mode:'demo',tenantId:'private-tenant',runId:'private-batch',sqlitePath:path,clickhouse:{url:'',database:'da',user:'test',password:''}});
async function listen(server:Server) {server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;}
async function close(server:Server) {if(!server.listening)return;const done=once(server,'close');server.close();server.closeAllConnections();await done;}
async function request(url:string,path:string,body?:unknown) {const r=await fetch(url+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,...await r.json()};}
async function fixture(url:string,date='2026-10-23') {await request(url,'/api/detections',{scenario:'failure_burst',windowStart:date+'T14:00'});return (await request(url,'/api/alerts')).data.items.find((a:any)=>a.windowStart.startsWith(date));}
const content=()=>({summary:{text:'鉴权失败集中，需优先核查授权配置。',evidenceIds:['E01']},findings:[{text:'失败记录表明访问异常，无法证明传播。',evidenceIds:['E01']}],alternativeExplanations:[{text:'可能存在配置变更或失败重试。',evidenceIds:['E01']}],unknowns:[{text:'实际原因尚待核实。',evidenceIds:['E01']}],recommendedChecks:[{text:'核对服务状态与授权配置。',evidenceIds:['E01']}]});

test('report snapshot, exact export hash, review revision, archive and restart preserve original evidence',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'traceguard-report-')), config=cfg(join(dir,'test.sqlite'));
  const app=createApp(config);let url=await listen(app.server), second:ReturnType<typeof createApp>|undefined;
  try {
    const alert=await fixture(url), base=await request(url,'/api/reports',{alertIds:[alert.id]});
    assert.equal(base.status,200);const report=base.data.report,id=report.payload.id,hash=report.integrity.hash;
    assert.equal(report.integrity.verified,true);assert.equal(report.payload.snapshot.run.dataBatchId,'private-batch');
    assert.equal((await request(url,'/api/reports',{alertIds:[alert.id]})).data.reused,true);
    const exported=await fetch(url+`/api/reports/${id}/evidence`),raw=await exported.text();
    assert.equal(sha256(raw),hash);assert.equal(exported.headers.get('x-content-sha256'),hash);assert.equal(raw,canonicalJSON(report.payload));
    assert.deepEqual(report.payload.facts[0].subject,{type:'VIDEO',id:alert.videoId});
    assert.match(report.payload.assessment.summary,/各项不相加/);assert.equal(report.payload.assessment.mode,'RULE_BASED');
    const body={status:'观察中',note:'私有人工备注不要外发',expectedVersion:1,requestId:'review-for-report'};
    await request(url,`/api/alerts/${alert.id}/reviews`,body);
    const revised=(await request(url,'/api/reports',{alertIds:[alert.id]})).data.report;
    assert.equal(revised.payload.revision,2);assert.notEqual(revised.payload.id,id);
    const original=(await request(url,`/api/reports/${id}`)).data;
    assert.equal(original.integrity.hash,hash);assert.equal(original.payload.snapshot.alerts[0].reviews.length,0);
    const archive={note:'功能测试：已核查范围和留存说明',expectedHash:hash,requestId:'archive-report-001'};
    assert.equal((await request(url,`/api/reports/${id}/archive`,{...archive,expectedHash:'0'.repeat(64)})).status,409);
    assert.equal((await request(url,`/api/reports/${id}/archive`,archive)).status,200);
    assert.equal((await request(url,`/api/reports/${id}/archive`,archive)).status,200);
    assert.equal((await request(url,`/api/reports/${id}/archive`,{...archive,note:'changed'})).status,409);
    await close(app.server);second=createApp(config);url=await listen(second.server);
    const restored=(await request(url,`/api/reports/${id}`)).data;
    assert.equal(restored.integrity.hash,hash);assert.equal(restored.archive.note,archive.note);assert.equal(restored.payload.snapshot.alerts[0].status,'待复核');
  }finally{await close(app.server);if(second)await close(second.server);rmSync(dir,{recursive:true,force:true});}
});

test('report scope rejects cross-run/duplicate/oversized selections and tampered report cannot export or archive',async()=>{
  const app=createApp(cfg()),url=await listen(app.server);
  try {
    const a=await fixture(url),b=await fixture(url,'2026-10-22');
    for(const ids of [[],[a.id,a.id],Array(9).fill(a.id),[a.id,b.id]])assert.equal((await request(url,'/api/reports',{alertIds:ids})).status,400);
    const report=(await request(url,'/api/reports',{alertIds:[a.id]})).data.report,id=report.payload.id;
    const changed={...report.payload,tenantId:'tampered'};
    app.store.db.prepare('UPDATE evidence_reports SET payload=? WHERE id=?').run(JSON.stringify(changed),id);
    assert.equal((await request(url,`/api/reports/${id}/verify`)).data.verified,false);
    assert.equal((await fetch(url+`/api/reports/${id}/evidence`)).status,409);
    assert.equal((await request(url,`/api/reports/${id}/archive`,{note:'test',expectedHash:report.integrity.hash,requestId:'archive-test-key'})).status,409);
  }finally{await close(app.server);}
});

test('model input excludes identifiers and free text; numeric output and citations are strictly bounded',async()=>{
  const app=createApp(cfg()),url=await listen(app.server);
  try {
    const a=await fixture(url);await request(url,`/api/alerts/${a.id}/reviews`,{status:'观察中',note:'秘密备注 192.0.2.123 token-private',expectedVersion:1,requestId:'redaction-review'});
    const report=(await request(url,'/api/reports',{alertIds:[a.id]})).data.report;
    const input=canonicalJSON(llmContext(report.payload));
    for(const secret of ['private-tenant','private-batch',a.videoId,a.id,'秘密备注','192.0.2.123','token-private'])assert.equal(input.includes(secret),false);
    assert.deepEqual(validateModelContent(content(),report.payload),content());
    assert.throws(()=>validateModelContent({...content(),summary:{text:'有 999999 个设备',evidenceIds:['E01']}},report.payload));
    assert.throws(()=>validateModelContent({...content(),summary:{text:'已确认',evidenceIds:['E99']}},report.payload));
    assert.throws(()=>validateModelContent({...content(),score:100},report.payload));
    assert.throws(()=>validateModelContent({...content(),summary:{text:'自动封禁',evidenceIds:['E01']}},report.payload));
    assert.equal((await request(url,`/api/reports/${report.payload.id}/analyze`,{expectedHash:report.integrity.hash,requestId:'not-configured-llm'})).status,503);
  }finally{await close(app.server);}
});

test('real HTTP model contract, request replay, manual adoption and archive never change rule scores',async()=>{
  let calls=0,captured:any;const upstream=createServer(async(req,res)=>{
    calls++;const chunks=[];for await(const part of req)chunks.push(part);captured=JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization,'Bearer test-key');assert.equal(req.url,'/v1/chat/completions');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'test-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify(content())}}],usage:{prompt_tokens:12,completion_tokens:24}}));
  });
  const upstreamUrl=await listen(upstream),config=cfg();config.llm={provider:'bailian',baseUrl:upstreamUrl+'/v1',model:'test-model',apiKey:'test-key'};
  const app=createApp(config),url=await listen(app.server);
  try {
    const alert=await fixture(url),r=(await request(url,'/api/reports',{alertIds:[alert.id]})).data.report,id=r.payload.id;
    const body={expectedHash:r.integrity.hash,requestId:'model-test-request'};
    const generated=(await request(url,`/api/reports/${id}/analyze`,body)).data;
    const task=generated.analyses[0];assert.equal(task.status,'SUCCEEDED');assert.equal(task.verified,true);assert.equal(task.review,null);
    assert.equal(task.inputHash,sha256(canonicalJSON(task.input)));assert.equal(canonicalJSON(task.input).includes('private-tenant'),false);
    assert.equal(captured.response_format.type,'json_object');assert.equal(captured.enable_thinking,false);
    assert.equal(JSON.stringify(captured).includes(alert.videoId),false);
    await request(url,`/api/reports/${id}/analyze`,body);assert.equal(calls,1);
    const review={decision:'ADOPTED',note:'仅采用配置排查建议，未认定侵权',requestId:'adopt-model-001'};
    const adopted=await request(url,`/api/reports/${id}/analyses/${task.id}/review`,review);assert.equal(adopted.status,200);
    assert.equal(adopted.data.analyses[0].review.decision,'ADOPTED');assert.equal(adopted.data.integrity.hash,r.integrity.hash);
    assert.deepEqual(adopted.data.payload,r.payload);
    assert.equal((await request(url,`/api/reports/${id}/analyses/${task.id}/review`,review)).status,200);
    assert.equal((await request(url,`/api/reports/${id}/analyses/${task.id}/review`,{...review,decision:'REJECTED'})).status,409);
    const unchanged=(await request(url,`/api/alerts/${alert.id}`)).data;assert.equal(unchanged.anomalyScore,alert.anomalyScore);assert.equal(unchanged.status,alert.status);
    await request(url,`/api/reports/${id}/archive`,{note:'功能测试归档',expectedHash:r.integrity.hash,requestId:'archive-model-001'});
    assert.equal((await request(url,`/api/reports/${id}/analyze`,{...body,requestId:'model-after-archive'})).status,409);
    assert.equal(calls,1);
    const record=await fetch(url+`/api/reports/${id}/analyses`);assert.equal(record.status,200);assert.equal((await record.json()).analyses[0].outputHash,task.outputHash);
    const stored=app.store.analyses(id)[0];stored.content!.summary.text='tampered';app.store.finishAnalysis(stored);
    assert.equal((await request(url,`/api/reports/${id}`)).data.analyses[0].verified,false);
    assert.equal((await fetch(url+`/api/reports/${id}/analyses`)).status,409);
  }finally{await close(app.server);await close(upstream);}
});

test('upstream failures are recorded without response bodies, secrets or fallback output',async()=>{
  let mode='http',calls=0;const upstream=createServer((_req,res)=>{calls++;if(mode==='http'){res.writeHead(401);res.end('secret-provider-diagnostic');}else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({...content(),summary:{text:'无依据',evidenceIds:['E99']}})}}]}));}});
  const upstreamUrl=await listen(upstream),config=cfg();config.llm={provider:'bailian',baseUrl:upstreamUrl,model:'test-model',apiKey:'test-key'};
  const app=createApp(config),url=await listen(app.server);
  try {
    const alert=await fixture(url),r=(await request(url,'/api/reports',{alertIds:[alert.id]})).data.report;
    const body={expectedHash:r.integrity.hash,requestId:'failure-model-001'},path=`/api/reports/${r.payload.id}/analyze`;
    const result=(await request(url,path,body)).data;assert.equal(result.analyses[0].status,'FAILED');assert.match(result.analyses[0].error,/HTTP 401/);assert.equal(JSON.stringify(result).includes('secret-provider-diagnostic'),false);
    await request(url,path,body);assert.equal(calls,1);mode='invalid';
    const invalid=(await request(url,path,{...body,requestId:'failure-model-002'})).data;assert.equal(invalid.analyses[0].status,'FAILED');assert.equal(invalid.analyses[0].content,null);assert.equal(invalid.integrity.hash,r.integrity.hash);
  }finally{await close(app.server);await close(upstream);}
});

test('interrupted model tasks fail on restart; pending analysis blocks archive',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'traceguard-ai-')),config=cfg(join(dir,'test.sqlite')),app=createApp(config);const url=await listen(app.server);let second:ReturnType<typeof createApp>|undefined;
  try {
    const a=await fixture(url),r=app.store.createReport({alertIds:[a.id]}).report,model=new ModelClient(undefined);
    const task=app.store.startAnalysis(r.payload.id,{requestId:'interrupted-model-001',expectedHash:r.integrity.hash},{model:'test-model',promptVersion:PROMPT_VERSION,inputHash:sha256(canonicalJSON(model.prepare(r.payload)))}).task;
    assert.throws(()=>app.store.archiveReport(r.payload.id,{note:'premature',requestId:'archive-pending-001',expectedHash:r.integrity.hash}),/模型请求/);
    await close(app.server);second=createApp(config);
    const failed=second.store.getReport(r.payload.id).analyses![0];assert.equal(failed.id,task.id);assert.equal(failed.status,'FAILED');assert.match(failed.error!,/重启/);
  }finally{await close(app.server);second?.store.close();rmSync(dir,{recursive:true,force:true});}
});
