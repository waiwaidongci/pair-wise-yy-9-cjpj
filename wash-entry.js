// 入口层：HTTP 路由、请求解析与洗水回用页面
import http from "node:http";
import { loadDb, saveDb, tankView, addEvent } from "./wash-store.js";
import {
  RuleError,
  openWash,
  rememberResult,
  changeWater,
  addSample,
  releaseWash,
  finishWash,
  correctWash,
  recomputeWash,
  releaseCheck,
  FAIL_REASONS
} from "./wash-rules.js";

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function decorate(wash) {
  return {
    ...wash,
    releaseReady: wash.status === "awaiting_water" ? releaseCheck(wash).canRelease : false
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const db = await loadDb();

    if (req.method === "GET" && p === "/") return html(res, page());

    if (req.method === "GET" && p === "/api/tanks") {
      return send(res, 200, tankView(db));
    }
    if (req.method === "GET" && p === "/api/batches") {
      return send(res, 200, db.waterBatches);
    }
    if (req.method === "GET" && p === "/api/washes") {
      let list = db.washes;
      const status = url.searchParams.get("status");
      const q = (url.searchParams.get("q") || "").trim();
      if (status) list = list.filter(w => w.status === status);
      if (q) list = list.filter(w =>
        [w.id, w.plateCode, w.batchCode, w.filterNo, w.waterSource, w.tankCode]
          .filter(Boolean).some(v => v.includes(q))
      );
      return send(res, 200, list.map(decorate));
    }
    if (req.method === "GET" && p === "/api/queue") {
      return send(res, 200, db.washes.filter(w => w.status === "awaiting_water").map(decorate));
    }
    if (req.method === "GET" && p === "/api/events") {
      return send(res, 200, db.events.slice(0, 50));
    }
    const one = p.match(/^\/api\/washes\/([^/]+)$/);
    if (one && req.method === "GET") {
      const wash = db.washes.find(w => w.id === one[1]);
      if (!wash) return send(res, 404, { error: "not_found" });
      return send(res, 200, decorate(wash));
    }

    if (req.method === "POST" && p === "/api/washes/open") {
      const input = await body(req);
      const result = openWash(db, input);
      if (result.persistIdem) rememberResult(db, input.requestId, result.status, result.body);
      await saveDb();
      // 重放仍返回首条 wash/gate，仅附加 replay 标记
      return send(res, result.status, { ...result.body, replay: result.replay });
    }
    const action = p.match(/^\/api\/washes\/([^/]+)\/(water-change|sample|release|finish|correct|recompute)$/);
    if (action && req.method === "POST") {
      const id = action[1];
      const input = { washId: id, ...(await body(req)) };
      let wash;
      switch (action[2]) {
        case "water-change": wash = changeWater(db, input); break;
        case "sample": {
          const r = addSample(db, input);
          await saveDb();
          return send(res, 200, { wash: decorate(r.wash), releaseCheck: r.releaseCheck });
        }
        case "release": wash = releaseWash(db, input); break;
        case "finish": wash = finishWash(db, input); break;
        case "correct": wash = correctWash(db, input); break;
        case "recompute": {
          const r = recomputeWash(db, id);
          await saveDb();
          return send(res, 200, { wash: decorate(r.wash), gate: r.gate, note: r.note });
        }
      }
      await saveDb();
      return send(res, 200, decorate(wash));
    }

    // 小工具：登记新水批（方便演示过期/有效水批切换）
    if (req.method === "POST" && p === "/api/batches") {
      const input = await body(req);
      const code = String(input.code || "").trim();
      const source = String(input.source || "").trim();
      const expiresAt = String(input.expiresAt || "").trim();
      if (!code || !source || !expiresAt) return send(res, 400, { error: "bad_request", message: "水批、水源、到期日必填" });
      if (db.waterBatches.some(b => b.code === code)) return send(res, 409, { error: "batch_exists" });
      db.waterBatches.push({ code, source, expiresAt });
      addEvent(db, { type: "batch_added", plateCode: null, detail: `登记水批 ${code}（${source}，有效期至 ${expiresAt}）` });
      await saveDb();
      return send(res, 201, db.waterBatches);
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof RuleError) {
      return send(res, 400, { error: error.code, message: error.message, ...error.extra });
    }
    send(res, 500, { error: "internal_error", message: error.message });
  }
});

export function startWashServer(port) {
  server.listen(port, () => console.log(`蓝晒洗水回用与残留放行模块 listening on http://localhost:${port}`));
  return server;
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>蓝晒洗水回用与残留放行</title>
<style>
:root { --bg:#eef2f4; --panel:#fff; --ink:#1d2730; --muted:#66757f; --line:#cfd9de; --accent:#2f6d8f; --warn:#a8462f; --ok:#3f7a4d; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
header { padding:20px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:14px; }
h1 { margin:0; font-size:23px; } h2 { margin:0 0 10px; font-size:16px; } h3 { margin:0; font-size:15px; }
.meta { color:var(--muted); font-size:12.5px; }
main { display:grid; grid-template-columns:360px 1fr; gap:18px; padding:18px 26px; align-items:start; }
form,.panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
form { margin-bottom:14px; }
label { display:block; margin:9px 0 4px; color:var(--muted); font-size:12.5px; }
input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; margin-top:10px; }
button.ghost { background:#5d7280; } button.ok { background:var(--ok); } button.warn { background:var(--warn); }
.row { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
.toolbar select,.toolbar input { width:auto; min-width:150px; }
.tanks { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; margin-bottom:14px; }
.tank { border:1px solid var(--line); border-radius:8px; padding:10px; background:#fafdfb; }
.tank.busy { background:#fdf3f0; border-color:#e3b7ab; }
.pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
.pill.washing { background:#e7f1f6; border-color:#9fc3d4; }
.pill.awaiting_water { background:#fdf0e3; border-color:#e6c49a; color:#8a5a22; }
.pill.finished { background:#eef4ef; color:var(--ok); }
.card { margin-bottom:10px; display:grid; gap:7px; }
.kv { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:4px 10px; font-size:13px; }
.kv b { color:var(--muted); font-weight:400; }
.logs { border-top:1px dashed var(--line); padding-top:6px; max-height:110px; overflow:auto; font-size:12px; color:var(--muted); display:grid; gap:2px; }
.bad { color:var(--warn); font-weight:700; } .good { color:var(--ok); font-weight:700; }
.mini { display:flex; gap:6px; flex-wrap:wrap; align-items:end; }
.mini > div { flex:1; min-width:90px; }
.versions { font-size:12px; color:var(--muted); border-top:1px dashed var(--line); padding-top:6px; display:grid; gap:3px; }
#toast { position:fixed; right:20px; bottom:20px; max-width:380px; display:grid; gap:8px; z-index:9; }
.toast { background:#22303a; color:#fff; border-radius:8px; padding:10px 14px; font-size:13px; }
.toast.err { background:var(--warn); } .toast.ok { background:var(--ok); }
.events { max-height:260px; overflow:auto; font-size:12.5px; display:grid; gap:5px; }
.events div { border-bottom:1px dashed var(--line); padding-bottom:4px; }
@media (max-width:960px){ main{grid-template-columns:1fr;} }
</style>
</head>
<body>
<header>
  <div><h1>蓝晒洗水回用与残留放行</h1>
  <div class="meta">开洗四闸（水批有效期 / 银≤0.5 / 电导率≤800 / 滤芯占用）；换水后另一人隔半小时连续两次取样，银≤0.1 且压差≤10 kPa 放行</div></div>
  <button id="reload" class="ghost">刷新</button>
</header>
<main>
  <section>
    <form id="openForm">
      <h2>开洗</h2>
      <div class="row">
        <div><label>底片编号（同底片结束前锁定）</label><input name="plateCode" required placeholder="如 CP-12"></div>
        <div><label>操作者</label><input name="startOperator" required placeholder="开洗人"></div>
      </div>
      <div class="row">
        <div><label>水批</label><select name="batchCode" id="batchSelect" required></select></div>
        <div><label>滤芯号</label><input name="filterNo" required placeholder="如 F-07"></div>
      </div>
      <div class="row">
        <div><label>银离子 mg/L（上限 0.5）</label><input name="silver" type="number" step="0.01" required></div>
        <div><label>电导率 μS/cm（上限 800）</label><input name="conductivity" type="number" step="1" required></div>
      </div>
      <div><label>水源（不填则随水批）</label><input name="waterSource" placeholder="可选，覆盖水批水源"></div>
      <div class="meta">请求号 <span id="openRid"></span>，重复提交重放首条结果</div>
      <button>提交开洗</button>
    </form>

    <form id="changeForm">
      <h2>换水（另一人操作）</h2>
      <label>待换水洗程</label><select name="washId" id="changeSelect" required></select>
      <div class="row">
        <div><label>换水操作者（≠开洗人）</label><input name="operator" required></div>
        <div><label>新水批（可更正，留空沿用）</label><select name="batchCode" id="changeBatch"><option value="">沿用当前</option></select></div>
      </div>
      <div class="row">
        <div><label>新滤芯号（留空沿用）</label><input name="filterNo" placeholder="可更正"></div>
        <div><label>新水源（留空沿用）</label><input name="waterSource" placeholder="可更正"></div>
      </div>
      <button class="ghost">登记换水</button>
    </form>

    <form id="sampleForm">
      <h2>连续取样（换水半小时后）</h2>
      <label>待换水洗程</label><select name="washId" id="sampleSelect" required></select>
      <div class="row">
        <div><label>取样操作者（≠开洗人）</label><input name="operator" required></div>
        <div><label>取样时间（留空=现在）</label><input name="at" type="datetime-local"></div>
      </div>
      <div class="row">
        <div><label>银离子 mg/L（放行≤0.1）</label><input name="silver" type="number" step="0.001" required></div>
        <div><label>压差 kPa（放行≤10）</label><input name="diffPressure" type="number" step="0.1" required></div>
      </div>
      <button class="ghost">提交取样</button>
    </form>

    <form id="correctForm">
      <h2>更正水批 / 滤芯 / 水源（放行失效，旧版只读）</h2>
      <label>洗程</label><select name="washId" id="correctSelect" required></select>
      <div class="row">
        <div><label>更正操作者</label><input name="operator" required></div>
        <div><label>新水批</label><select name="batchCode" id="correctBatch"><option value="">不更正</option></select></div>
      </div>
      <div class="row">
        <div><label>新滤芯号</label><input name="filterNo" placeholder="不更正留空"></div>
        <div><label>新水源</label><input name="waterSource" placeholder="不更正留空"></div>
      </div>
      <button class="warn">更正并重算</button>
    </form>
  </section>

  <section>
    <div class="panel" style="margin-bottom:14px"><h2>洗槽</h2><div class="tanks" id="tanks"></div></div>
    <div class="toolbar">
      <select id="statusFilter">
        <option value="">全部洗程</option>
        <option value="washing">洗片中</option>
        <option value="awaiting_water">待换水</option>
        <option value="finished">已结束</option>
      </select>
      <input id="search" placeholder="筛选底片 / 水批 / 滤芯 / 洗槽">
      <button id="releaseAll" class="ok">放行所有达标洗程</button>
    </div>
    <div class="panel" style="margin-bottom:14px">
      <h2>待换水队列</h2>
      <div id="queue" class="meta">加载中…</div>
    </div>
    <div class="panel" style="margin-bottom:14px"><h2>洗程履历</h2><div id="cards"></div></div>
    <div class="panel"><h2>事件流</h2><div class="events" id="events"></div></div>
  </section>
</main>
<div id="toast"></div>
<script>
const $ = s => document.querySelector(s);
let washes = [], tanks = [], batches = [];
async function api(path, opts) {
  const res = await fetch(path, opts && opts.body ? { ...opts, headers: { 'Content-Type': 'application/json' } } : opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || '请求失败');
  return data;
}
function toast(msg, ok) {
  const el = document.createElement('div');
  el.className = 'toast ' + (ok === false ? 'err' : 'ok');
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function rid() { return 'REQ-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
function fmt(at) { return at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : ''; }
const STATUS = { washing: '洗片中', awaiting_water: '待换水', finished: '已结束' };

function fillBatches() {
  const opts = batches.map(b => '<option value="' + b.code + '">' + b.code + ' · ' + b.source + ' · 至 ' + b.expiresAt + '</option>').join('');
  $('#batchSelect').innerHTML = opts;
  $('#changeBatch').innerHTML = '<option value="">沿用当前</option>' + opts;
  $('#correctBatch').innerHTML = '<option value="">不更正</option>' + opts;
}
function washOptions(sel, all) {
  const list = all ? washes : washes.filter(w => w.status === 'awaiting_water');
  sel.innerHTML = list.map(w => '<option value="' + w.id + '">' + w.id + ' · ' + w.plateCode + ' · ' + STATUS[w.status] + '</option>').join('');
}

function renderTanks() {
  $('#tanks').innerHTML = tanks.map(t =>
    '<div class="tank ' + (t.occupied ? 'busy' : '') + '"><h3>' + t.code + '</h3>' +
    '<div class="meta">' + (t.occupied
      ? '占用：' + t.plateCode + '<br>滤芯 ' + t.filterNo + '<br>' + t.washId + '<br>' + fmt(t.startedAt)
      : '空闲') + '</div></div>').join('');
}
function sampleLines(w) {
  const ver = w.versions[w.versions.length - 1];
  const ep = ver.episodes[ver.episodes.length - 1];
  if (!ep) return '<div class="meta">尚未换水</div>';
  if (!ep.samples.length) return '<div class="meta">已换水，等待第 1 次取样（换水后半小时）</div>';
  return ep.samples.map((s, i) => {
    const silverOk = s.silver <= 0.1, dpOk = s.diffPressure <= 10;
    return '<div>第' + (i + 1) + '次 ' + fmt(s.at) + ' ' + s.operator +
      '：银 <span class="' + (silverOk ? 'good' : 'bad') + '">' + s.silver + '</span> / 压差 <span class="' + (dpOk ? 'good' : 'bad') + '">' + s.diffPressure + '</span> kPa</div>';
  }).join('');
}
function versionsHtml(w) {
  if (w.versions.length <= 1 && !w.pastReleases) return '';
  return '<div class="versions">' + w.versions.map(v =>
    '<div>v' + v.version + (v.version === w.versions.length ? '（当前）' : '（只读旧版）') +
    '：水批 ' + v.batchCode + ' / 滤芯 ' + v.filterNo + ' / 水源 ' + v.source + '</div>').join('') +
    (w.pastReleases || []).map(r => '<div class="bad">旧放行 v' + r.version + ' 已于 ' + fmt(r.invalidatedAt) + ' 失效（' + r.invalidatedBy + ' 更正）</div>').join('') +
    '</div>';
}
function cardHtml(w) {
  const gateBad = w.status === 'awaiting_water' && !w.versions.slice(-1)[0].episodes.length;
  const actions = [];
  if (w.status === 'washing') actions.push('<button class="ghost" data-finish="' + w.id + '">洗片结束</button>');
  if (w.status === 'awaiting_water') {
    actions.push('<button class="ghost" data-recompute="' + w.id + '">重算四闸</button>');
    if (w.releaseReady) actions.push('<button class="ok" data-release="' + w.id + '">残留放行</button>');
  }
  return '<article class="card"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center">' +
    '<h3>' + w.id + ' · ' + w.plateCode + '</h3><span class="pill ' + w.status + '">' + STATUS[w.status] + '</span></div>' +
    '<div class="kv"><span><b>洗槽</b>' + (w.tankCode || '未占用') + '</span>' +
    '<span><b>水批</b>' + w.batchCode + '</span><span><b>滤芯</b>' + w.filterNo + '</span>' +
    '<span><b>水源</b>' + (w.waterSource || '') + '</span>' +
    '<span><b>开洗</b>' + fmt(w.startedAt || w.createdAt) + ' / ' + w.openMeasure.operator + '</span>' +
    '<span><b>初测</b>银 ' + w.openMeasure.silver + ' / 电导 ' + w.openMeasure.conductivity + '</span></div>' +
    '<div>' + sampleLines(w) +
    (w.status === 'awaiting_water' ? (w.releaseReady
      ? '<div class="good">连续两次达标，可放行</div>'
      : '<div class="meta">放行条件：另一人换水后隔半小时连续 2 次，银≤0.1 且压差≤10</div>') : '') +
    (w.release ? '<div class="good">已放行 v' + w.release.version + ' @ ' + fmt(w.release.releasedAt) + '</div>' : '') +
    '</div>' + versionsHtml(w) +
    '<div class="logs">' + w.history.map(h => '<div>' + fmt(h.at) + ' ' + h.action + '：' + h.note + '</div>').join('') + '</div>' +
    '<div class="mini">' + actions.join('') + '</div></article>';
}
function render() {
  washOptions($('#changeSelect'), false);
  washOptions($('#sampleSelect'), false);
  washOptions($('#correctSelect'), true);
  const status = $('#statusFilter').value;
  const q = $('#search').value.trim();
  const visible = washes.filter(w =>
    (!status || w.status === status) &&
    (!q || [w.id, w.plateCode, w.batchCode, w.filterNo, w.waterSource, w.tankCode].filter(Boolean).some(v => v.includes(q))));
  $('#cards').innerHTML = visible.map(cardHtml).join('') || '<div class="meta">无洗程</div>';
  const queue = washes.filter(w => w.status === 'awaiting_water');
  $('#queue').innerHTML = queue.length ? queue.map(w =>
    '<span class="pill awaiting_water">' + w.id + ' · ' + w.plateCode + '（' +
    (w.versions.slice(-1)[0].episodes.length
      ? (w.releaseReady ? '取样达标待放行' : '换水后取样中')
      : '开洗未过闸，未占槽') + '）</span>').join(' ') : '队列为空';
  bindCardButtons();
}
function bindCardButtons() {
  document.querySelectorAll('[data-finish]').forEach(b => b.onclick = async () => {
    const operator = prompt('结束确认操作者'); if (!operator) return;
    try { await api('/api/washes/' + b.dataset.finish + '/finish', { method: 'POST', body: JSON.stringify({ operator }) }); toast('洗程已结束，洗槽释放'); await load(); }
    catch (e) { toast(e.message, false); }
  });
  document.querySelectorAll('[data-release]').forEach(b => b.onclick = async () => {
    try { const w = await api('/api/washes/' + b.dataset.release + '/release', { method: 'POST', body: '{}' }); toast('已放行，占用 ' + w.tankCode); await load(); }
    catch (e) { toast(e.message, false); }
  });
  document.querySelectorAll('[data-recompute]').forEach(b => b.onclick = async () => {
    try {
      const r = await api('/api/washes/' + b.dataset.recompute + '/recompute', { method: 'POST', body: '{}' });
      toast(r.gate ? (r.gate.pass ? '四闸重算通过' : '四闸仍未过：' + r.gate.reasons.join('；')) : r.note);
      await load();
    } catch (e) { toast(e.message, false); }
  });
}
async function load() {
  [washes, tanks, batches] = await Promise.all([api('/api/washes'), api('/api/tanks'), api('/api/batches')]);
  fillBatches(); renderTanks(); render();
  api('/api/events').then(evs => $('#events').innerHTML = evs.map(e =>
    '<div><span class="meta">' + fmt(e.at) + '</span> ' + e.detail + '</div>').join('') || '');
}
$('#openRid').textContent = rid();
$('#openForm').onsubmit = async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData($('#openForm')).entries());
  data.requestId = $('#openRid').textContent;
  try {
    const r = await api('/api/washes/open', { method: 'POST', body: JSON.stringify(data) });
    toast((r.replay ? '重放首条结果：' : '') + (r.gate.pass ? '开洗成功，已占槽' : '只转待换水：' + r.gate.reasons.join('；')), r.gate.pass);
    $('#openForm').reset(); $('#openRid').textContent = rid(); await load();
  } catch (err) { toast(err.message, false); }
};
$('#changeForm').onsubmit = async e => {
  e.preventDefault();
  const f = $('#changeForm'), data = Object.fromEntries(new FormData(f).entries());
  try { await api('/api/washes/' + data.washId + '/water-change', { method: 'POST', body: JSON.stringify(data) }); toast('换水已登记'); f.reset(); await load(); }
  catch (err) { toast(err.message, false); }
};
$('#sampleForm').onsubmit = async e => {
  e.preventDefault();
  const f = $('#sampleForm'), data = Object.fromEntries(new FormData(f).entries());
  try {
    const r = await api('/api/washes/' + data.washId + '/sample', { method: 'POST', body: JSON.stringify(data) });
    toast(r.releaseCheck.canRelease ? '取样达标，可放行' : '取样已记录，尚未满足连续两次达标');
    f.reset(); await load();
  } catch (err) { toast(err.message, false); }
};
$('#correctForm').onsubmit = async e => {
  e.preventDefault();
  const f = $('#correctForm'), data = Object.fromEntries(new FormData(f).entries());
  try { await api('/api/washes/' + data.washId + '/correct', { method: 'POST', body: JSON.stringify(data) }); toast('已更正，放行失效，旧版只读，回到待换水重算'); f.reset(); await load(); }
  catch (err) { toast(err.message, false); }
};
$('#releaseAll').onclick = async () => {
  const ready = washes.filter(w => w.releaseReady);
  if (!ready.length) return toast('没有达标待放行的洗程', false);
  let n = 0;
  for (const w of ready) {
    try { await api('/api/washes/' + w.id + '/release', { method: 'POST', body: '{}' }); n++; }
    catch (e) { toast(w.id + '：' + e.message, false); }
  }
  toast('已放行 ' + n + ' 个洗程'); await load();
};
$('#statusFilter').onchange = render; $('#search').oninput = render; $('#reload').onclick = load;
load();
</script>
</body>
</html>`;
}
