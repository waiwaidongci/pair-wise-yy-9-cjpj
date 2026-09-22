// 入口层：HTTP 路由编排（解析请求 → 调判定层 → 经存储层落盘）
import {
  SILVER_LIMIT_START, SILVER_LIMIT_RELEASE, CONDUCTIVITY_LIMIT, PRESSURE_LIMIT,
  evaluateStart, checkSample, evaluateRelease, applyCorrection, checkWaterBatch
} from "./rules.js";

export function todayStr(now = new Date()) {
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
}
function nowIso() { return new Date().toISOString(); }

function required(input, keys) {
  const missing = keys.filter(k => input[k] === undefined || input[k] === null || String(input[k]).trim() === "");
  if (missing.length) return `缺少必填项：${missing.join("、")}`;
  return null;
}
function numericIssue(input, keys) {
  for (const k of keys) {
    if (input[k] === undefined) continue;
    const n = Number(input[k]);
    if (Number.isNaN(n)) return `${k} 必须是数字`;
  }
  return null;
}

export function createApiRouter(store) {
  return async function route(req, res, url, send) {
    // GET /api/state：洗槽、待换水队列、履历、阈值，刷新后一致的唯一数据源
    if (req.method === "GET" && url.pathname === "/api/state") {
      const washes = store.listWashes();
      return send(res, 200, {
        tanks: store.data.tanks.map(t => {
          const occ = store.tankOccupant(t);
          return { tank: t, busy: Boolean(occ), occupant: occ && { id: occ.id, negativeCode: occ.negativeCode, filterNo: occ.filterNo, operator: occ.operator } };
        }),
        waterBatches: store.data.waterBatches,
        thresholds: { silverStart: SILVER_LIMIT_START, silverRelease: SILVER_LIMIT_RELEASE, conductivity: CONDUCTIVITY_LIMIT, pressure: PRESSURE_LIMIT },
        washes
      });
    }

    // POST /api/washes：开洗（水批、电导率、银离子、滤芯号、操作者）
    if (req.method === "POST" && url.pathname === "/api/washes") {
      const input = await readBody(req);
      const miss = required(input, ["negativeCode", "waterBatch", "conductivity", "silverIon", "filterNo", "operator"]);
      if (miss) return send(res, 400, { error: miss });
      const badNum = numericIssue(input, ["conductivity", "silverIon"]);
      if (badNum) return send(res, 400, { error: badNum });

      // 幂等重放：相同 requestId 返回首条结果
      if (input.requestId) {
        const first = store.getByRequest(input.requestId);
        if (first && first.wash) return send(res, first.http, { ...first.wash, replayed: true });
      }

      // 同张底片洗片结束前不能开第二洗程
      const active = store.activeWashForNegative(input.negativeCode.trim());
      if (active) return send(res, 409, { error: `${input.negativeCode} 已有未结束洗程 ${active.id}（${active.status}），结束前不能开第二洗程` });

      const waterBatch = store.waterBatch(input.waterBatch.trim());
      const filterOccupant = store.data.washes.find(w => w.status === "洗片中" && w.filterNo === input.filterNo.trim()) || null;
      const decision = evaluateStart(
        { ...input, silverIon: Number(input.silverIon), conductivity: Number(input.conductivity), filterNo: input.filterNo.trim() },
        { waterBatch, todayStr: todayStr(), filterOccupant }
      );

      const wash = {
        id: store.newId(),
        requestId: input.requestId || null,
        negativeCode: input.negativeCode.trim(),
        tank: null,
        waterBatch: input.waterBatch.trim(),
        waterSource: waterBatch ? waterBatch.source : (input.waterSource || "未知水源"),
        conductivity: Number(input.conductivity),
        silverIon: Number(input.silverIon),
        filterNo: input.filterNo.trim(),
        operator: input.operator.trim(),
        status: "待换水",
        reasons: decision.reasons,
        startedAt: nowIso(),
        endedAt: null,
        change: null,
        samples: [],
        releasedAt: null,
        releaseOperator: null,
        versions: [],
        history: []
      };

      if (!decision.ok) {
        // 水批过期 / 银离子>0.5 / 电导率>800 / 滤芯被占用：只转待换水，不占洗槽
        wash.history.push({ at: wash.startedAt, action: "开洗", note: "判定不通过（" + decision.reasons.join("；") + "），转待换水，未占洗槽" });
        store.addWash(wash, 202);
        await store.save();
        return send(res, 202, wash);
      }

      const tank = store.freeTank();
      if (!tank) {
        wash.reasons = ["暂无空闲洗槽"];
        wash.history.push({ at: wash.startedAt, action: "开洗", note: "水质合格但暂无空闲洗槽，排队等待" });
        store.addWash(wash, 202);
        await store.save();
        return send(res, 202, wash);
      }
      wash.status = "洗片中";
      wash.tank = tank;
      wash.history.push({ at: wash.startedAt, action: "开洗", note: `水质合格，占用${tank}，滤芯 ${wash.filterNo}` });
      store.addWash(wash, 201);
      await store.save();
      return send(res, 201, wash);
    }

    // POST /api/washes/:id/change：换水登记，进入检测
    const changeMatch = url.pathname.match(/^\/api\/washes\/([^/]+)\/change$/);
    if (changeMatch && req.method === "POST") {
      const wash = store.getWash(changeMatch[1]);
      if (!wash) return send(res, 404, { error: "洗程不存在" });
      if (wash.status !== "待换水") return send(res, 409, { error: `当前状态 ${wash.status} 不能换水` });
      const input = await readBody(req);
      const miss = required(input, ["waterBatch", "operator"]);
      if (miss) return send(res, 400, { error: miss });
      const waterBatch = store.waterBatch(input.waterBatch.trim());
      const batchIssue = checkWaterBatch(waterBatch, todayStr());
      if (batchIssue) return send(res, 400, { error: batchIssue });

      wash.status = "检测中";
      wash.reasons = [];
      wash.change = { at: nowIso(), waterBatch: waterBatch.code, waterSource: waterBatch.source, operator: input.operator.trim() };
      wash.waterBatch = waterBatch.code;
      wash.waterSource = waterBatch.source;
      wash.samples = [];
      wash.history.push({ at: wash.change.at, action: "换水", note: `${input.operator.trim()} 更换水批 ${waterBatch.code}（${waterBatch.source}），等待另一人隔半小时连续取样` });
      await store.save();
      return send(res, 200, wash);
    }

    // POST /api/washes/:id/samples：换水后连续取样
    const sampleMatch = url.pathname.match(/^\/api\/washes\/([^/]+)\/samples$/);
    if (sampleMatch && req.method === "POST") {
      const wash = store.getWash(sampleMatch[1]);
      if (!wash) return send(res, 404, { error: "洗程不存在" });
      if (wash.status !== "检测中") return send(res, 409, { error: `当前状态 ${wash.status}，请先换水` });
      const input = await readBody(req);
      const miss = required(input, ["sampler", "silverIon", "pressureDiff"]);
      if (miss) return send(res, 400, { error: miss });
      const badNum = numericIssue(input, ["silverIon", "pressureDiff"]);
      if (badNum) return send(res, 400, { error: badNum });

      const checked = checkSample(input, wash, Date.now());
      if (checked.error) return send(res, 400, { error: checked.error });
      wash.samples.push(checked.sample);
      wash.history.push({ at: checked.sample.at, action: "取样", note: `${input.sampler.trim()}：银离子 ${Number(input.silverIon)} mg/L，压差 ${Number(input.pressureDiff)} kPa（第 ${wash.samples.length} 次）` });
      await store.save();
      return send(res, 201, wash);
    }

    // POST /api/washes/:id/release：残留放行判定
    const releaseMatch = url.pathname.match(/^\/api\/washes\/([^/]+)\/release$/);
    if (releaseMatch && req.method === "POST") {
      const wash = store.getWash(releaseMatch[1]);
      if (!wash) return send(res, 404, { error: "洗程不存在" });
      if (wash.status !== "检测中") return send(res, 409, { error: `当前状态 ${wash.status}，还不能放行` });
      const input = await readBody(req);
      const verdict = evaluateRelease(wash);
      if (!verdict.ok) return send(res, 400, { error: verdict.reason, samples: wash.samples });
      wash.status = "已放行";
      wash.releasedAt = nowIso();
      wash.releaseOperator = (input.operator || "").trim() || wash.samples[wash.samples.length - 1].sampler;
      wash.history.push({ at: wash.releasedAt, action: "放行", note: `${verdict.reason}（确认人：${wash.releaseOperator}）` });
      await store.save();
      return send(res, 200, wash);
    }

    // POST /api/washes/:id/finish：洗片结束，释放洗槽与滤芯
    const finishMatch = url.pathname.match(/^\/api\/washes\/([^/]+)\/finish$/);
    if (finishMatch && req.method === "POST") {
      const wash = store.getWash(finishMatch[1]);
      if (!wash) return send(res, 404, { error: "洗程不存在" });
      if (wash.status !== "洗片中" && wash.status !== "已放行")
        return send(res, 409, { error: `当前状态 ${wash.status}，无法结束洗片` });
      wash.status = "已结束";
      wash.endedAt = nowIso();
      wash.tank = null;
      wash.history.push({ at: wash.endedAt, action: "结束", note: "洗片结束，释放洗槽与滤芯" });
      await store.save();
      return send(res, 200, wash);
    }

    // PATCH /api/washes/:id：更正水批/滤芯/水源等；命中关键字段放行失效重算
    const patchMatch = url.pathname.match(/^\/api\/washes\/([^/]+)$/);
    if (patchMatch && req.method === "PATCH") {
      const wash = store.getWash(patchMatch[1]);
      if (!wash) return send(res, 404, { error: "洗程不存在" });
      if (wash.status === "已结束") return send(res, 409, { error: "已结束洗程只读，不能更正" });
      const input = await readBody(req);
      const miss = required(input, ["operator"]);
      if (miss) return send(res, 400, { error: miss });

      if (input.waterBatch !== undefined) {
        const waterBatch = store.waterBatch(String(input.waterBatch).trim());
        const batchIssue = checkWaterBatch(waterBatch, todayStr());
        if (batchIssue) return send(res, 400, { error: batchIssue });
        input.waterSource = waterBatch.source;
      }
      const badNum = numericIssue(input, ["conductivity", "silverIon"]);
      if (badNum) return send(res, 400, { error: badNum });

      const result = applyCorrection(wash, input, String(input.operator).trim());
      if (!result.changes.length) return send(res, 400, { error: "没有可更正的变化" });
      const desc = result.changes.map(c => `${labelOf(c.field)}：${c.from} → ${c.to}`).join("；");
      wash.history.push({
        at: nowIso(),
        action: "更正",
        note: result.invalidated ? `${input.operator.trim()} 更正 ${desc}，放行失效，旧版只读，需重新换水取样` : `${input.operator.trim()} 更正 ${desc}`
      });
      await store.save();
      return send(res, 200, { wash, invalidated: result.invalidated, changes: result.changes });
    }

    // GET /api/washes/:id/versions/:v：旧版只读查看
    const verMatch = url.pathname.match(/^\/api\/washes\/([^/]+)\/versions\/(\d+)$/);
    if (verMatch && req.method === "GET") {
      const wash = store.getWash(verMatch[1]);
      if (!wash) return send(res, 404, { error: "洗程不存在" });
      const version = wash.versions.find(v => v.version === Number(verMatch[2]));
      if (!version) return send(res, 404, { error: "旧版不存在" });
      return send(res, 200, { readOnly: true, washId: wash.id, version });
    }

    return send(res, 404, { error: "not_found" });
  };
}

function labelOf(field) {
  return { waterBatch: "水批", filterNo: "滤芯号", waterSource: "水源", conductivity: "电导率", silverIon: "银离子" }[field] || field;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
