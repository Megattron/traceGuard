// 事件回放：告警详情内的三条轨迹（授权 / 内容 / 环境）+ 可拖动时间游标。
// 只渲染后端返回的已观察记录，不补画虚构事件。
// 后端的 points / progress / auth 事件时间均为相对窗口起点的毫秒偏移（absT 换算）。
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = ms => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
const msClock = ms => `${clock(ms)}.${String(new Date(ms).getMilliseconds()).padStart(3, '0')}`;
const fmtInt = n => Math.round(n).toLocaleString('zh-CN');
const spanText = seconds => seconds >= 5400 ? `${(seconds / 3600).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 小时` : `${Math.round(seconds)} 秒`;

const GUTTER = 208, LANE_H = 30, GROUP_H = 20, AXIS_H = 26, RIGHT_PAD = 10;
const AUTH_COLORS = {
  TOKEN_CREATE: '#24846d', TOKEN_RENEW: '#5aa78e', MANIFEST_REQUEST: '#2563d9', HLS_KEY_VALIDATE: '#7fa7e8',
  KEY_RESPONSE: '#ad7619', REQUEST_REJECTED: '#c74d4c',
};
const ENV_PALETTE = ['#2563d9', '#ad7619', '#24846d', '#7c5cbf', '#c74d4c', '#0f7d9c'];
const cache = new Map();

const shortToken = ref => ref.length <= 22 ? ref : `…${ref.slice(-22)}`;

function upperBound(sorted, value, key = item => item) {
  let low = 0, high = sorted.length;
  while (low < high) { const mid = (low + high) >> 1; key(sorted[mid]) <= value ? low = mid + 1 : high = mid; }
  return low;
}

function niceStep(span) {
  for (const step of [1000, 2000, 5000, 10000, 30000, 60000, 300000, 900000, 1800000, 3600000, 7200000, 14400000])
    if (span / step <= 8) return step;
  return 43200000;
}

export function mountReplay(container, alert, api, options = {}) {
  if (!container) return;
  const displayId = options.displayId || (id => id);
  container.innerHTML = '<div class="replay-loading">正在加载事件回放…</div>';
  if (!cache.has(alert.id)) cache.set(alert.id, api(`/api/alerts/${encodeURIComponent(alert.id)}/timeline`));
  cache.get(alert.id).then(timeline => {
    if (!container.isConnected) return;
    render(container, timeline, displayId);
  }).catch(error => {
    if (!container.isConnected) return;
    container.innerHTML = `<div class="replay-error">事件回放加载失败：${esc(error.message)}<button class="button secondary small" data-replay-retry>重试</button></div>`;
    container.querySelector('[data-replay-retry]')?.addEventListener('click', () => { cache.delete(alert.id); mountReplay(container, alert, api, options); });
  });
}

function render(container, timeline, displayId) {
  const t0 = Date.parse(timeline.windowStart.replace(' ', 'T') + '+08:00');
  const t1 = Date.parse(timeline.windowEnd.replace(' ', 'T') + '+08:00');
  const span = t1 - t0;
  const absT = offset => t0 + offset;
  container.innerHTML = `
  <div class="replay">
    <div class="replay-head">
      <h4>事件回放</h4><span class="sub">授权 · 内容 · 环境三条轨迹，同一时间游标 · ${esc(timeline.windowStart.slice(11, 19))} — ${esc(timeline.windowEnd.slice(11, 19))}（北京时间）</span>
      <div class="replay-controls">
        <span class="replay-time" id="replay-time"></span>
        <button class="button primary small" id="replay-play">▶ 播放</button>
      </div>
    </div>
    <div class="replay-chips">${replayChips(timeline).map(([text, cls]) => `<span class="replay-chip ${cls || ''}">${esc(text)}</span>`).join('')}</div>
    <div class="replay-layout">
      <div>
        <div class="replay-canvas-wrap" id="replay-wrap" tabindex="0" role="slider" aria-label="事件回放时间游标" aria-valuemin="0" aria-valuemax="${span}" aria-valuenow="0">
          <canvas id="replay-canvas"></canvas>
          <div class="replay-tooltip" id="replay-tooltip" hidden></div>
        </div>
        <div class="replay-legend">
          <span><i style="background:#24846d"></i>签发 / 续期</span><span><i style="background:#2563d9"></i>播放清单</span>
          <span><i style="background:#ad7619"></i>解密密钥</span><span><i style="background:#c74d4c"></i>拒绝 / 失败</span>
          <span><i style="background:rgba(37,99,217,.55)"></i>内容请求</span><span><i style="background:#8490a1"></i>环境请求点</span>
          <span>颜色随游标推进点亮，浅色为尚未发生</span>
        </div>
        <div class="replay-basis">${esc(timeline.content.basis)}。${esc(timeline.scopeNote)}。</div>
      </div>
      <div>
        <div class="replay-readout" id="replay-readout"></div>
        <div class="replay-side">
          ${[['observed', '已观察事实', timeline.sidebar.observed], ['risk', '支持的风险方向', timeline.sidebar.risk], ['unknown', '尚不能确认', timeline.sidebar.unknown], ['next', '建议下一步', timeline.sidebar.next]]
            .map(([cls, title, items]) => `<div class="replay-block ${cls}"><h5>${title}</h5>${items.length ? `<ul>${items.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : '<p class="muted">—</p>'}</div>`).join('')}
        </div>
      </div>
    </div>
    ${timeline.limitations.length ? `<div class="replay-basis">边界：${timeline.limitations.map(esc).join('；')}。</div>` : ''}
    <p class="replay-note">回放仅使用该告警窗口内已有的采集记录，不补画虚构事件；IP 与客户端标识是环境线索，不等于设备或自然人。游标可拖动，也可用左右方向键微调。</p>
  </div>`;

  const wrap = container.querySelector('#replay-wrap');
  const canvas = container.querySelector('#replay-canvas');
  const tooltip = container.querySelector('#replay-tooltip');
  const timeEl = container.querySelector('#replay-time');
  const readout = container.querySelector('#replay-readout');
  const playButton = container.querySelector('#replay-play');
  const ctx = canvas.getContext('2d');

  // 轨道布局：组标题行 + 各轨迹行；没有记录的组如实标注
  const lanes = [];
  lanes.push({ kind: 'group', title: '授权轨迹' });
  const authTokens = timeline.auth.tokens.length ? timeline.auth.tokens : [{ ref: '', issuedAt: 0, effectiveAt: 0, expiresAt: 0, revoked: false, allowedVideos: [] }];
  for (const token of authTokens) {
    lanes.push({ kind: 'auth', token, events: timeline.auth.tokens.length ? timeline.auth.events.filter(event => event.tokenRef === token.ref) : timeline.auth.events });
  }
  lanes.push({ kind: 'group', title: '内容轨迹' });
  if (timeline.content.courses.length) for (const course of timeline.content.courses) lanes.push({ kind: 'content', course });
  else lanes.push({ kind: 'empty', title: '窗口内没有可回放的内容请求' });
  lanes.push({ kind: 'group', title: '环境轨迹' });
  if (timeline.env.environments.length) timeline.env.environments.forEach((environment, index) => lanes.push({ kind: 'env', environment, color: ENV_PALETTE[index % ENV_PALETTE.length] }));
  else lanes.push({ kind: 'empty', title: '窗口内没有可信的环境记录' });

  const firstCandidates = [timeline.auth.events[0]?.t, timeline.content.courses[0]?.firstT, timeline.env.environments[0]?.firstT].filter(Number.isFinite).map(absT);
  let cursorT = firstCandidates.length ? Math.max(t0, Math.min(...firstCandidates) - span * 0.02) : t0;
  let playing = false, rafId = null, hitItems = [], layout = null;

  function computeLayout(width) {
    const plotW = Math.max(120, width - GUTTER - RIGHT_PAD);
    let y = AXIS_H;
    const rows = [];
    for (const lane of lanes) {
      const height = lane.kind === 'group' ? GROUP_H : LANE_H;
      rows.push({ lane, y, height });
      y += height;
    }
    return { width, plotW, rows, height: y + 6 };
  }

  const xOf = t => GUTTER + (t - t0) / span * layout.plotW;
  const tOf = x => t0 + Math.min(1, Math.max(0, (x - GUTTER) / layout.plotW)) * span;
  const alpha = t => (t <= cursorT ? 1 : 0.25);
  const stemY = (center, index) => center + (index % 2 === 0 ? -9 : 9);

  function buildHits() {
    hitItems = [];
    for (const row of layout.rows) {
      const cy = row.y + row.height / 2;
      if (row.lane.kind === 'auth') {
        row.lane.events.forEach((event, index) => hitItems.push({
          x: xOf(absT(event.t)), y: stemY(cy, index), r: 7, title: event.label,
          lines: [msClock(absT(event.t)), event.status !== null ? `HTTP ${event.status}` : '', event.keyValidUntil !== null ? `密钥有效至 ${clock(absT(event.keyValidUntil))}` : ''].filter(Boolean),
        }));
      } else if (row.lane.kind === 'content') {
        const course = row.lane.course, failed = new Set(course.failedPoints);
        for (const offset of course.points) hitItems.push({
          x: xOf(absT(offset)), y: cy, r: 5, title: `内容请求 · ${displayId(course.videoId, 'VIDEO')}`,
          lines: [msClock(absT(offset)), failed.has(offset) ? '请求失败' : '请求通过'],
        });
      } else if (row.lane.kind === 'env') {
        for (const offset of row.lane.environment.points) hitItems.push({
          x: xOf(absT(offset)), y: cy, r: 6, title: row.lane.environment.label,
          lines: [msClock(absT(offset)), row.lane.environment.ua ? `UA ${row.lane.environment.ua}` : ''].filter(Boolean),
        });
      }
    }
  }

  function resize() {
    const width = wrap.clientWidth || 640;
    layout = computeLayout(width);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(layout.height * ratio);
    canvas.style.height = `${layout.height}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    buildHits();
    draw();
  }

  function draw() {
    if (!layout) return;
    ctx.clearRect(0, 0, layout.width, layout.height);
    ctx.font = '10px Inter, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#8490a1';
    ctx.textAlign = 'left';
    ctx.fillText('时间（北京时间）', 10, 16);
    const step = niceStep(span);
    ctx.textAlign = 'center';
    for (let t = t0 + step; t <= t1; t += step) {
      const x = xOf(t);
      ctx.fillStyle = '#eef2f8';
      ctx.fillRect(Math.round(x) + 0.5, AXIS_H - 8, 1, layout.height - AXIS_H + 2);
      ctx.fillStyle = '#8490a1';
      ctx.fillText(clock(t), x, 16);
    }
    for (const row of layout.rows) {
      const cy = row.y + row.height / 2;
      if (row.lane.kind === 'group') {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#66748c';
        ctx.font = '600 10px Inter, "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.fillText(row.lane.title, 10, row.y + 13);
        ctx.strokeStyle = '#edf1f7';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(GUTTER - 6, row.y + row.height - 4); ctx.lineTo(layout.width - 4, row.y + row.height - 4); ctx.stroke();
      } else if (row.lane.kind === 'empty') {
        ctx.textAlign = 'left';
        ctx.fillStyle = '#a7b1c2';
        ctx.font = 'italic 10px Inter, "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.fillText(row.lane.title, GUTTER + 8, cy + 3);
      } else if (row.lane.kind === 'auth') drawAuthLane(row.lane, cy);
      else if (row.lane.kind === 'content') drawContentLane(row.lane, cy);
      else if (row.lane.kind === 'env') drawEnvLane(row.lane, cy);
    }
    const cx = Math.round(xOf(cursorT)) + 0.5;
    ctx.strokeStyle = '#223047';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, AXIS_H - 10); ctx.lineTo(cx, layout.height - 2); ctx.stroke();
    ctx.fillStyle = '#223047';
    ctx.beginPath(); ctx.moveTo(cx - 4, AXIS_H - 12); ctx.lineTo(cx + 4, AXIS_H - 12); ctx.lineTo(cx, AXIS_H - 5); ctx.closePath(); ctx.fill();
  }

  function drawAuthLane(lane, cy) {
    const token = lane.token;
    ctx.textAlign = 'left';
    ctx.font = '10px Inter, "Segoe UI", "Microsoft YaHei", sans-serif';
    if (token.ref) {
      ctx.fillStyle = '#4a5872';
      ctx.fillText(`凭证 ${shortToken(token.ref)}`, 10, cy - 2);
      ctx.fillStyle = token.revoked ? '#c74d4c' : '#8490a1';
      ctx.fillText(token.revoked ? '已撤销' : `有效至 ${clock(token.expiresAt)}`, 10, cy + 9);
      const left = Math.max(t0, token.issuedAt), right = Math.min(t1, Math.max(token.expiresAt, token.issuedAt));
      if (right > left) {
        ctx.fillStyle = token.revoked ? 'rgba(199,77,76,.3)' : 'rgba(36,132,109,.28)';
        ctx.strokeStyle = token.revoked ? '#c74d4c' : '#24846d';
        roundRect(xOf(left), cy - 4, xOf(right) - xOf(left), 8);
        ctx.fill(); ctx.stroke();
        if (token.issuedAt < t0) { // 窗口前签发
          ctx.fillStyle = '#24846d';
          ctx.beginPath(); ctx.moveTo(GUTTER + 3, cy - 6); ctx.lineTo(GUTTER + 3, cy + 6); ctx.lineTo(GUTTER - 3, cy); ctx.closePath(); ctx.fill();
        }
        if (token.expiresAt <= t1) {
          ctx.fillStyle = '#8490a1';
          ctx.textAlign = 'right';
          ctx.fillText('失效', xOf(token.expiresAt) - 3, cy - 8);
        }
      }
    } else {
      ctx.fillStyle = '#8490a1';
      ctx.fillText('凭证（缺少快照）', 10, cy + 3);
    }
    for (const event of lane.events) {
      const eventT = absT(event.t);
      if (event.kind === 'KEY_RESPONSE' && event.keyValidUntil !== null && event.keyValidUntil > event.t) {
        const left = Math.max(t0, eventT), right = Math.min(t1, absT(event.keyValidUntil));
        ctx.fillStyle = `rgba(173,118,25,${alpha(eventT) * 0.4})`;
        roundRect(xOf(left), cy + 6, xOf(right) - xOf(left), 3);
        ctx.fill();
        ctx.textAlign = 'left';
        ctx.fillStyle = `rgba(140,95,20,${alpha(eventT)})`;
        ctx.fillText(`密钥有效至 ${clock(absT(event.keyValidUntil))}`, Math.min(xOf(right) + 6, layout.width - 118), cy + 11);
      }
    }
    lane.events.forEach((event, index) => {
      const x = xOf(absT(event.t)), y = stemY(cy, index);
      ctx.globalAlpha = alpha(absT(event.t));
      ctx.strokeStyle = '#b6c2d4';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = AUTH_COLORS[event.kind] || '#8490a1';
      ctx.beginPath(); ctx.arc(x, y, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  function drawContentLane(lane, cy) {
    const course = lane.course;
    ctx.textAlign = 'left';
    ctx.font = '10px Inter, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#4a5872';
    ctx.fillText(`课程 ${displayId(course.videoId, 'VIDEO')}`, 10, cy - 2);
    ctx.fillStyle = '#8490a1';
    ctx.fillText(course.totalSeconds ? `${fmtInt(course.dedupSeconds)}/${fmtInt(course.totalSeconds)} 秒` : `${fmtInt(course.dedupSeconds)} 秒`, 10, cy + 9);
    if (course.firstT !== null && course.lastT !== null && course.lastT > course.firstT) {
      const left = xOf(absT(course.firstT)), right = xOf(absT(course.lastT));
      ctx.fillStyle = '#e3ecfa';
      roundRect(left, cy - 5, right - left, 10);
      ctx.fill();
      const covered = course.totalSeconds ? Math.min(1, course.dedupSeconds / course.totalSeconds) : 0;
      ctx.fillStyle = 'rgba(37,99,217,.75)';
      roundRect(left, cy - 5, Math.max(2, (right - left) * covered), 10);
      ctx.fill();
    }
    const failed = new Set(course.failedPoints);
    for (const offset of course.points) {
      const t = absT(offset);
      ctx.fillStyle = failed.has(offset) ? `rgba(199,77,76,${alpha(t) * 0.9})` : `rgba(37,99,217,${alpha(t) * 0.55})`;
      ctx.fillRect(Math.round(xOf(t)), cy - 8, 1, 16);
    }
  }

  function drawEnvLane(lane, cy) {
    ctx.textAlign = 'left';
    ctx.font = '10px Inter, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#4a5872';
    ctx.fillText(lane.environment.label, 10, cy - 2);
    ctx.fillStyle = '#8490a1';
    ctx.fillText(`${fmtInt(lane.environment.count ?? lane.environment.points.length)} 个请求点`, 10, cy + 9);
    for (const offset of lane.environment.points) {
      const t = absT(offset);
      ctx.globalAlpha = alpha(t);
      ctx.fillStyle = lane.color;
      ctx.beginPath(); ctx.arc(xOf(t), cy, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function roundRect(x, y, width, height) {
    const radius = Math.min(3, height / 2, width / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  function readoutAt(t) {
    const lines = [`<b>${msClock(t)}</b> <span class="neg">（窗口起点 + ${((t - t0) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 秒）</span>`];
    if (timeline.content.requests) {
      let requests = 0, seconds = 0;
      for (const course of timeline.content.courses) {
        const entry = course.progress[upperBound(course.progress, t - t0, item => item.t) - 1];
        if (entry) { requests += entry.req; seconds += entry.sec; }
      }
      lines.push(`内容：已请求 <b>${fmtInt(requests)}</b> 次，去重内容 <b>${spanText(seconds)}</b>${timeline.content.medianGapMs ? ` <span class="neg">（间隔中位 ${fmtInt(timeline.content.medianGapMs)} ms）</span>` : ''}`);
    }
    if (timeline.auth.tokens.length) {
      const token = [...timeline.auth.tokens].filter(item => item.issuedAt <= t).sort((a, b) => a.issuedAt - b.issuedAt).at(-1);
      const state = !token ? '尚未签发' : token.revoked ? '已撤销' : t < token.expiresAt ? `有效（至 ${clock(token.expiresAt)}）` : '已过期';
      lines.push(`授权：token ${state}`);
    }
    const key = [...timeline.auth.events].filter(event => event.kind === 'KEY_RESPONSE' && event.t <= t - t0).sort((a, b) => a.t - b.t).at(-1);
    if (key) lines.push(`密钥：${key.keyValidUntil !== null && key.keyValidUntil > t - t0 ? `有效（至 ${clock(absT(key.keyValidUntil))}）` : '已过期或未知'}`);
    const authNear = timeline.auth.events.filter(event => Math.abs(event.t - (t - t0)) <= 400);
    const near = [...new Set(authNear.map(event => event.label))].map(label => `${label} ×${authNear.filter(event => event.label === label).length}`);
    const contentNear = timeline.content.courses.reduce((sum, course) => sum + upperBound(course.points, t - t0 + 400) - upperBound(course.points, t - t0 - 400), 0);
    if (contentNear) near.push(`内容请求 ×${fmtInt(contentNear)}`);
    if (near.length) lines.push(`游标 ±0.4 秒内：${near.join('，')}`);
    readout.innerHTML = lines.join('<br>');
  }

  function setCursor(t, fromPlay = false) {
    cursorT = Math.min(t1, Math.max(t0, t));
    if (!fromPlay && playing) stopPlay();
    wrap.setAttribute('aria-valuenow', Math.round(cursorT - t0));
    wrap.setAttribute('aria-valuetext', msClock(cursorT));
    timeEl.textContent = `${msClock(cursorT)} · +${((cursorT - t0) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}s`;
    readoutAt(cursorT);
    draw();
  }

  function stopPlay() {
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    playButton.textContent = '▶ 播放';
  }

  playButton.addEventListener('click', () => {
    if (playing) { stopPlay(); return; }
    playing = true;
    playButton.textContent = '⏸ 暂停';
    const from = cursorT >= t1 - span * 0.001 ? t0 : cursorT;
    const startedAt = performance.now();
    const tick = now => {
      if (!playing) return;
      const progress = Math.min(1, (now - startedAt) / 12000);
      setCursor(from + progress * (t1 - from), true);
      if (progress < 1) rafId = requestAnimationFrame(tick);
      else stopPlay();
    };
    rafId = requestAnimationFrame(tick);
  });

  const xToT = clientX => tOf(clientX - wrap.getBoundingClientRect().left);
  wrap.addEventListener('pointerdown', event => {
    try { wrap.setPointerCapture(event.pointerId); } catch { /* 合成事件或指针已失效 */ }
    setCursor(xToT(event.clientX));
  });
  wrap.addEventListener('pointermove', event => {
    if (event.buttons & 1) { setCursor(xToT(event.clientX)); return; }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    let best = null;
    for (const item of hitItems) {
      const distance = Math.hypot(item.x - x, item.y - y);
      if (distance < item.r + 3 && (!best || distance < best.distance)) best = { item, distance };
    }
    if (best) {
      tooltip.hidden = false;
      tooltip.innerHTML = `<b>${esc(best.item.title)}</b><br>${best.item.lines.map(line => `<small>${esc(line)}</small>`).join('<br>')}`;
      tooltip.style.left = `${Math.min(Math.max(best.item.x + 12, 0), wrap.clientWidth - 190)}px`;
      tooltip.style.top = `${Math.max(2, best.item.y - 14)}px`;
    } else tooltip.hidden = true;
  });
  wrap.addEventListener('pointerleave', () => { tooltip.hidden = true; });
  wrap.addEventListener('keydown', event => {
    const step = span / 240 * (event.shiftKey ? 10 : 1);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setCursor(cursorT + (event.key === 'ArrowRight' ? step : -step));
    } else if (event.key === 'Home') { event.preventDefault(); setCursor(t0); }
    else if (event.key === 'End') { event.preventDefault(); setCursor(t1); }
  });

  new ResizeObserver(() => resize()).observe(wrap);
  resize();
  setCursor(cursorT);
}

function replayChips(timeline) {
  const chips = [];
  const seconds = timeline.windowSeconds;
  chips.push([`窗口 ${seconds >= 5400 ? `${(seconds / 3600).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 小时` : `${Math.round(seconds / 60)} 分钟`}`]);
  if (timeline.content.dedupSeconds > 0) {
    if (seconds <= 600 && timeline.content.speedRatio !== null && timeline.content.speedRatio >= 1) {
      const ratio = timeline.content.speedRatio >= 10 ? Math.round(timeline.content.speedRatio) : timeline.content.speedRatio.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
      chips.push([`去重内容 ${fmtInt(timeline.content.dedupSeconds)} 秒 · ${ratio} 倍速`, 'em']);
    } else {
      chips.push([`去重内容 ${spanText(timeline.content.dedupSeconds)}`]);
      if (timeline.content.activeMinutes !== null) chips.push([`活跃 ${fmtInt(timeline.content.activeMinutes)} 分钟`]);
    }
    if (timeline.content.coverageRatio !== null) chips.push([`分片覆盖 ${(timeline.content.coverageRatio * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%${timeline.content.strictlyIncreasing ? ' · 严格递增' : ''}`]);
    if (timeline.content.medianGapMs !== null) chips.push([`间隔中位 ${fmtInt(timeline.content.medianGapMs)} ms${(timeline.content.gapCv ?? 1) < 0.1 ? ' · 无波动' : (timeline.content.gapCv ?? 1) < 0.35 ? ' · 波动小' : ''}`]);
  }
  if (timeline.env.environments.length > 1) chips.push([`环境 ${timeline.env.environments.length} 组${timeline.env.switches >= 3 ? ` · 交替 ${fmtInt(timeline.env.switches)} 次` : ''}`, 'em']);
  if (timeline.env.toolUa) chips.push([`工具特征 ${timeline.env.toolUa}`, 'alert']);
  if (timeline.auth.tokens.length === 1) chips.push([`token 有效至 ${clock(timeline.auth.tokens[0].expiresAt)}`, timeline.auth.tokens[0].revoked ? 'alert' : 'good']);
  return chips;
}
