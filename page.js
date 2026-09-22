// 视图层：洗水回用与残留放行页面（单页，所有数据来自 /api/state，刷新后一致）
export function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>蓝晒洗水回用与残留放行</title>
  <style>
    :root { --bg:#eef2ec; --panel:#fff; --ink:#1f241d; --muted:#667061; --line:#d2dccb; --accent:#3f6b46; --warn:#9b4937; --ok:#2f6d4f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
    header { padding:18px 26px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:12px; }
    h1 { margin:0; font-size:22px; } h2 { margin:0 0 10px; font-size:16px; } h3 { margin:0; font-size:15px; }
    main { display:grid; grid-template-columns:350px 1fr; gap:18px; padding:18px 26px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:12px; }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; }
    button.secondary { background:#6b776b; } button.danger { background:var(--warn); } button.mini { padding:5px 9px; font-size:12px; }
    .meta { color:var(--muted); font-size:12px; } .warn { color:var(--warn); font-weight:700; } .ok { color:var(--ok); font-weight:700; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(104px,1fr)); gap:10px; margin-bottom:14px; }
    .stat strong { display:block; font-size:22px; }
    .tanks { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-bottom:14px; }
    .tank { border:1px solid var(--line); border-radius:8px; padding:10px 12px; background:#fff; }
    .tank.busy { border-color:var(--warn); background:#fbf3f1; } .tank.free { border-color:var(--ok); background:#f2f8f3; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin:10px 0 12px; } .toolbar select,.toolbar input { width:auto; min-width:150px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .card { display:grid; gap:6px; align-content:start; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; justify-self:start; }
    .pill.洗片中 { background:#eef4ff; border-color:#9db8e8; } .pill.待换水 { background:#fdf0ec; border-color:#dca89a; color:var(--warn); }
    .pill.检测中 { background:#fdf7e6; border-color:#e3cf8f; } .pill.已放行 { background:#edf7f0; border-color:#9ac9aa; color:var(--ok); } .pill.已结束 { background:#eef0ed; color:var(--muted); }
    .kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:13px; }
    .samples { border-top:1px dashed var(--line); padding-top:6px; font-size:12px; }
    .hist { border-top:1px solid var(--line); padding-top:6px; max-height:110px; overflow:auto; font-size:12px; }
    .btns { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
    .queue-head { display:flex; align-items:center; gap:8px; margin:6px 0 10px; }
    .tag { font-size:11px; border-radius:4px; padding:1px 6px; background:#eef0ec; color:var(--muted); }
    #toast { position:fixed; right:20px; bottom:20px; max-width:380px; background:#26302a; color:#fff; padding:10px 14px; border-radius:8px; font-size:13px; display:none; white-space:pre-wrap; }
    #toast.err { background:var(--warn); }
    @media (max-width:920px){ header{padding:14px;} main{grid-template-columns:1fr;padding:14px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>蓝晒洗水回用与残留放行</h1><div class="meta">开洗判定 · 换水复检 · 连续取样放行 · 洗槽/滤芯占用与履历</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <section>
      <form id="startForm" class="panel">
        <h2>开洗登记</h2>
        <label>底片编号（同底片洗片结束前不能开第二洗程）</label><input name="negativeCode" required>
        <label>水批</label><select name="waterBatch" id="waterBatchSelect" required></select>
        <label>电导率 µS/cm（≤800）</label><input name="conductivity" type="number" step="0.1" required>
        <label>银离子 mg/L（≤0.5）</label><input name="silverIon" type="number" step="0.01" required>
        <label>滤芯号</label><input name="filterNo" placeholder="如 F-07" required>
        <label>操作者</label><input name="operator" required>
        <div style="margin-top:10px"><button>开洗</button><span class="meta" id="startHint"></span></div>
      </form>
      <div class="panel" style="margin-top:12px">
        <h2>规则速查</h2>
        <div class="meta" style="line-height:1.8">
          水批过期 / 银离子&gt;0.5 / 电导率&gt;800 / 滤芯被占用 → 只转<b>待换水</b>，不占洗槽。<br>
          换水后由<b>另一人</b>隔<b>30 分钟</b>连续取样（≥2 次），银离子均 ≤0.1、压差均 ≤10 kPa 才放行。<br>
          更正水批、滤芯或水源 → 放行失效、重新换水取样，旧版只读。
        </div>
      </div>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel">
        <h2>洗槽占用</h2>
        <div class="tanks" id="tanks"></div>
      </div>
      <div class="panel" style="margin-top:14px">
        <h2 class="queue-head">待换水队列 / 检测中 <span class="tag" id="queueCount"></span></h2>
        <div class="grid" id="queue"></div>
      </div>
      <div class="panel" style="margin-top:14px">
        <h2>洗程履历</h2>
        <div class="toolbar">
          <select id="statusFilter"><option value="">全部状态</option><option>洗片中</option><option>待换水</option><option>检测中</option><option>已放行</option><option>已结束</option></select>
          <select id="tankFilter"><option value="">全部洗槽</option></select>
          <input id="search" placeholder="搜底片/水批/滤芯/操作者">
        </div>
        <div class="grid" id="cards"></div>
      </div>
    </section>
  </main>
  <div id="toast"></div>

  <script>
    let state = { washes: [], tanks: [], waterBatches: [] };
    let startRequestId = genId();
    const $ = s => document.querySelector(s);
    function genId(){ return "req-" + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
    function esc(v){ return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
    function toast(msg, isErr){ const t = $("#toast"); t.textContent = msg; t.className = isErr ? "err" : ""; t.style.display = "block"; clearTimeout(t._timer); t._timer = setTimeout(() => t.style.display = "none", 4200); }
    async function api(path, options){
      const res = await fetch(path, options && options.body ? { ...options, headers: {"Content-Type":"application/json"} } : options);
      const data = await res.json();
      if (!res.ok) throw Object.assign(new Error(data.error || "请求失败"), { data });
      return data;
    }
    async function load(){
      state = await api("/api/state");
      render();
    }
    function render(){
      renderBatches();
      renderStats();
      renderTanks();
      renderQueue();
      renderHistory();
    }
    function renderBatches(){
      const today = new Date().toISOString().slice(0,10);
      $("#waterBatchSelect").innerHTML = state.waterBatches.map(b =>
        '<option value="'+esc(b.code)+'"'+(b.expiry < today ? " disabled" : "")+'>'+esc(b.code)+' · '+esc(b.source)+' · 到期 '+esc(b.expiry)+(b.expiry < today ? "（已过期）" : "")+'</option>').join("");
      $("#tankFilter").innerHTML = '<option value="">全部洗槽</option>' + state.tanks.map(t => '<option>'+esc(t.tank)+'</option>').join("");
    }
    function renderStats(){
      const labels = ["洗片中","待换水","检测中","已放行","已结束"];
      $("#stats").innerHTML = labels.map(s => '<div class="stat"><span class="meta">'+s+'</span><strong>'+state.washes.filter(w => w.status === s).length+'</strong></div>').join("");
    }
    function renderTanks(){
      $("#tanks").innerHTML = state.tanks.map(t => {
        if (!t.busy) return '<div class="tank free"><b>'+esc(t.tank)+'</b><div class="ok">空闲</div></div>';
        const o = t.occupant;
        return '<div class="tank busy"><b>'+esc(t.tank)+'</b><div class="warn">占用中</div><div class="meta">'+esc(o.negativeCode)+' · '+esc(o.id)+'<br>滤芯 '+esc(o.filterNo)+' · '+esc(o.operator)+'</div></div>';
      }).join("");
    }
    function renderQueue(){
      const list = state.washes.filter(w => w.status === "待换水" || w.status === "检测中");
      $("#queueCount").textContent = list.length + " 条";
      $("#queue").innerHTML = list.length ? list.map(cardHtml).join("") : '<div class="meta">队列已清空</div>';
      bindCards($("#queue"));
    }
    function renderHistory(){
      const status = $("#statusFilter").value, tank = $("#tankFilter").value, q = $("#search").value.trim();
      const list = state.washes.filter(w =>
        (!status || w.status === status) &&
        (!tank || w.tank === tank) &&
        (!q || [w.negativeCode,w.id,w.waterBatch,w.filterNo,w.operator,w.waterSource].join(" ").includes(q)));
      $("#cards").innerHTML = list.length ? list.map(cardHtml).join("") : '<div class="meta">没有符合筛选的洗程</div>';
      bindCards($("#cards"));
    }

    function samplesHtml(w){
      if (!w.samples || !w.samples.length) return "";
      const rows = w.samples.map((s,i) => '<div>第'+(i+1)+'次 · '+esc(s.at.replace("T"," ").slice(0,16))+' · '+esc(s.sampler)+' · Ag '+s.silverIon+' · ΔP '+s.pressureDiff+' kPa</div>').join("");
      return '<div class="samples"><b>连续取样</b>'+rows+'</div>';
    }
    function actionsHtml(w){
      const btns = [];
      if (w.status === "洗片中") btns.push('<button class="mini secondary" data-act="finish" data-id="'+w.id+'">结束洗片（释放洗槽）</button>');
      if (w.status === "待换水") btns.push('<button class="mini" data-act="change" data-id="'+w.id+'">换水</button>');
      if (w.status === "检测中") {
        btns.push('<button class="mini secondary" data-act="sample" data-id="'+w.id+'">登记取样</button>');
        btns.push('<button class="mini" data-act="release" data-id="'+w.id+'">判定放行</button>');
      }
      if (w.status !== "已结束") btns.push('<button class="mini danger" data-act="correct" data-id="'+w.id+'">更正</button>');
      return btns.length ? '<div class="btns">'+btns.join("")+'</div>' : '';
    }
    function cardHtml(w){
      const reasons = (w.reasons || []).length ? '<div class="warn">'+w.reasons.map(esc).join("<br>")+'</div>' : '';
      const change = w.change ? '<div class="meta">换水：'+esc(w.change.at.slice(0,16).replace("T"," "))+' · '+esc(w.change.operator)+' · '+esc(w.change.waterBatch)+'</div>' : '';
      const release = w.releasedAt ? '<div class="ok">已放行 '+esc(w.releasedAt.slice(0,16).replace("T"," "))+' · '+esc(w.releaseOperator)+'</div>' : '';
      const versions = w.versions.length ? '<div class="meta">旧版：'+w.versions.map(v => '<a href="/api/washes/'+encodeURIComponent(w.id)+'/versions/'+v.version+'" target="_blank">v'+v.version+'（只读）</a>').join(" · ")+'</div>' : '';
      const hist = (w.history || []).slice().reverse().map(h => '<div>['+esc(h.action)+'] '+esc(h.at.slice(0,16).replace("T"," "))+' '+esc(h.note)+'</div>').join("");
      return '<article class="card">'
        + '<h3>'+esc(w.negativeCode)+' <span class="tag">'+esc(w.id)+'</span></h3>'
        + '<span class="pill '+w.status+'">'+w.status+'</span>'
        + '<div class="kv">'
        +   '<span class="meta">洗槽</span><b>'+esc(w.tank || "未占用")+'</b>'
        +   '<span class="meta">水批</span><span>'+esc(w.waterBatch)+'（'+esc(w.waterSource)+'）</span>'
        +   '<span class="meta">开洗水质</span><span>电导率 '+w.conductivity+' · Ag '+w.silverIon+'</span>'
        +   '<span class="meta">滤芯</span><span>'+esc(w.filterNo)+'</span>'
        +   '<span class="meta">操作者</span><span>'+esc(w.operator)+'</span>'
        + '</div>'
        + reasons + change + samplesHtml(w) + release + versions
        + actionsHtml(w)
        + '<div class="hist">'+hist+'</div>'
        + '</article>';
    }
    function bindCards(root){
      root.querySelectorAll("[data-act]").forEach(btn => btn.onclick = () => act(btn.dataset.act, btn.dataset.id));
    }

    async function act(kind, id){
      try {
        if (kind === "finish") { await api("/api/washes/"+encodeURIComponent(id)+"/finish", { method:"POST", body:"{}" }); }
        if (kind === "change") {
          const wb = prompt("换水后的新水批（"+state.waterBatches.map(b=>b.code).join(" / ")+"）"); if (!wb) return;
          const op = prompt("换水操作者（取样须由另一人完成）"); if (!op) return;
          await api("/api/washes/"+encodeURIComponent(id)+"/change", { method:"POST", body: JSON.stringify({ waterBatch: wb.trim(), operator: op.trim() }) });
        }
        if (kind === "sample") {
          const sampler = prompt("取样人（须不同于开洗/换水操作者）"); if (!sampler) return;
          const silver = prompt("本次银离子 mg/L（放行线 ≤0.1）", "0.05"); if (silver === null) return;
          const pressure = prompt("滤芯压差 kPa（放行线 ≤10）", "6"); if (pressure === null) return;
          await api("/api/washes/"+encodeURIComponent(id)+"/samples", { method:"POST", body: JSON.stringify({ sampler: sampler.trim(), silverIon: silver, pressureDiff: pressure }) });
        }
        if (kind === "release") {
          await api("/api/washes/"+encodeURIComponent(id)+"/release", { method:"POST", body:"{}" });
          toast("连续取样合格，已放行，洗水可回用");
        }
        if (kind === "correct") {
          const field = prompt("更正哪一项？输入 waterBatch（水批）/ filterNo（滤芯）/ waterSource（水源）\\n注意：更正水批、滤芯或水源会令放行失效并重新计算");
          if (!field) return;
          if (!["waterBatch","filterNo","waterSource"].includes(field.trim())) { toast("只接受 waterBatch / filterNo / waterSource", true); return; }
          const value = prompt("更正后的"+field.trim()+(field.trim()==="waterBatch" ? "（"+state.waterBatches.map(b=>b.code).join(" / ")+"）" : "")); if (value === null) return;
          const op = prompt("更正操作者"); if (!op) return;
          const body = { operator: op.trim() }; body[field.trim()] = value.trim();
          const r = await api("/api/washes/"+encodeURIComponent(id), { method:"PATCH", body: JSON.stringify(body) });
          toast(r.invalidated ? "已更正：放行失效，旧版只读，需重新换水取样" : "已更正，放行保持有效");
        }
        await load();
      } catch (e) { toast(e.message, true); }
    }

    $("#startForm").onsubmit = async ev => {
      ev.preventDefault();
      const fd = Object.fromEntries(new FormData(ev.target).entries());
      try {
        const w = await api("/api/washes", { method:"POST", body: JSON.stringify({ ...fd, requestId: startRequestId }) });
        if (w.replayed) toast("重复提交：返回首条结果 " + w.id);
        else if (w.status === "洗片中") toast("开洗成功，占用 " + w.tank);
        else toast("只转待换水，未占洗槽：\\n" + (w.reasons || []).join("\\n"), true);
        startRequestId = genId();
        ev.target.reset();
        await load();
      } catch (e) { toast(e.message, true); }
    };
    $("#statusFilter").onchange = renderHistory;
    $("#tankFilter").onchange = renderHistory;
    $("#search").oninput = renderHistory;
    $("#reload").onclick = load;
    load();
  </script>
</body>
</html>`;
}
