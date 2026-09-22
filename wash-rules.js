// 判定层：蓝晒洗水回用与残留放行的全部业务规则
import { addEvent, nextId } from "./wash-store.js";

export const SILVER_OPEN_MAX = 0.5; // mg/L，开洗上限
export const SILVER_RELEASE_MAX = 0.1; // mg/L，换水后放行上限
export const CONDUCTIVITY_MAX = 800; // μS/cm
export const DIFF_PRESSURE_MAX = 10; // kPa
export const SAMPLE_INTERVAL_MS = 30 * 60 * 1000; // 半小时
export const REQUIRED_SAMPLES = 2; // 连续取样数

export const FAIL_REASONS = {
  water_expired: "水批已过期",
  silver_high: `银离子高于 ${SILVER_OPEN_MAX} mg/L`,
  conductivity_high: `电导率超过 ${CONDUCTIVITY_MAX} μS/cm`,
  filter_occupied: "滤芯已被其他洗程占用"
};

export class RuleError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra || {};
  }
}

function num(input, key, label) {
  const v = Number(input[key]);
  if (input[key] === undefined || input[key] === null || input[key] === "" || Number.isNaN(v)) {
    throw new RuleError("bad_request", `${label}必须为数字`);
  }
  return v;
}

function required(input, key, label) {
  const v = String(input[key] ?? "").trim();
  if (!v) throw new RuleError("bad_request", `${label}必填`);
  return v;
}

function dayEnd(dateStr) {
  return new Date(`${dateStr}T23:59:59.999Z`).getTime();
}

export function getBatch(db, code) {
  return db.waterBatches.find(b => b.code === code) || null;
}

export function activeWashOfPlate(db, plateCode) {
  return db.washes.find(w => w.plateCode === plateCode && w.status !== "finished") || null;
}

export function filterOccupiedBy(db, filterNo, excludeWashId) {
  return db.washes.find(w =>
    w.status === "washing" &&
    w.filterNo === filterNo &&
    w.id !== excludeWashId
  ) || null;
}

// 开洗四道闸：水批过期 / 银离子 / 电导率 / 滤芯占用
export function evaluateGate(db, p, { excludeWashId } = {}) {
  const failures = [];
  const batch = getBatch(db, p.batchCode);
  if (!batch || dayEnd(batch.expiresAt) < Date.now()) {
    failures.push("water_expired");
  }
  if (p.silver > SILVER_OPEN_MAX) failures.push("silver_high");
  if (p.conductivity > CONDUCTIVITY_MAX) failures.push("conductivity_high");
  if (filterOccupiedBy(db, p.filterNo, excludeWashId)) failures.push("filter_occupied");
  return {
    pass: failures.length === 0,
    failures,
    reasons: failures.map(f => FAIL_REASONS[f])
  };
}

function currentVersion(wash) {
  return wash.versions[wash.versions.length - 1];
}

function currentEpisode(wash) {
  const version = currentVersion(wash);
  return version.episodes[version.episodes.length - 1] || null;
}

function snapshotVersions(wash, keys) {
  const last = currentVersion(wash);
  const next = {
    version: last.version + 1,
    batchCode: keys.batchCode ?? last.batchCode,
    source: keys.source ?? last.source,
    filterNo: keys.filterNo ?? last.filterNo,
    episodes: []
  };
  wash.versions.push(next);
  wash.batchCode = next.batchCode;
  wash.waterSource = next.source;
  wash.filterNo = next.filterNo;
}

function logHistory(wash, at, action, note) {
  wash.history.push({ at, action, note: note || "" });
}

// 1) 开洗。重复 requestId 直接重放首条结果，不重新判定、不占槽
export function openWash(db, input) {
  const requestId = required(input, "requestId", "请求标识");
  const cached = db.idem[requestId];
  if (cached) {
    return { status: cached.status, body: cached.body, replay: true };
  }

  const plateCode = required(input, "plateCode", "底片编号");
  const batchCode = required(input, "batchCode", "水批");
  const filterNo = required(input, "filterNo", "滤芯号");
  const startOperator = required(input, "startOperator", "操作者");
  const silver = num(input, "silver", "银离子");
  const conductivity = num(input, "conductivity", "电导率");
  const sourceInput = String(input.waterSource ?? "").trim();

  const active = activeWashOfPlate(db, plateCode);
  if (active) {
    throw new RuleError("plate_locked", "同张底片洗片结束前不能开第二洗程", {
      plateCode,
      activeWashId: active.id,
      activeStatus: active.status
    });
  }

  const batch = getBatch(db, batchCode);
  const waterSource = sourceInput || (batch ? batch.source : "");
  const gate = evaluateGate(db, { batchCode, filterNo, silver, conductivity });

  const now = new Date().toISOString();
  const id = nextId(db, "WASH");

  if (!gate.pass) {
    // 只转待换水：不分配洗槽、滤芯也不占用
    const wash = {
      id,
      plateCode,
      status: "awaiting_water",
      tankCode: null,
      filterNo,
      batchCode,
      waterSource,
      versions: [{
        version: 1,
        batchCode,
        source: waterSource,
        filterNo,
        episodes: []
      }],
      openMeasure: { silver, conductivity, operator: startOperator, at: now },
      release: null,
      history: [],
      startedAt: null,
      finishedAt: null,
      createdAt: now
    };
    logHistory(wash, now, "open", `开洗判定未过：${gate.reasons.join("；")}，转待换水`);
    db.washes.unshift(wash);
    addEvent(db, {
      type: "open_queued",
      washId: id,
      plateCode,
      detail: `${plateCode} 开洗未过：${gate.reasons.join("；")}，进入待换水队列（未占洗槽）`
    });
    return { status: 200, body: { wash, gate, replay: false }, replay: false, persistIdem: true };
  }

  const freeTank = db.tanks.find(t =>
    !db.washes.some(w => w.status === "washing" && w.tankCode === t.code)
  );
  if (!freeTank) {
    throw new RuleError("no_free_tank", "没有空闲洗槽", { plateCode });
  }

  const wash = {
    id,
    plateCode,
    status: "washing",
    tankCode: freeTank.code,
    filterNo,
    batchCode,
    waterSource,
    versions: [{
      version: 1,
      batchCode,
      source: waterSource,
      filterNo,
      episodes: []
    }],
    openMeasure: { silver, conductivity, operator: startOperator, at: now },
    release: null,
    history: [],
    startedAt: now,
    finishedAt: null,
    createdAt: now
  };
  logHistory(wash, now, "open", `${startOperator} 开洗，占用 ${freeTank.code}，滤芯 ${filterNo}`);
  db.washes.unshift(wash);
  addEvent(db, {
    type: "open_started",
    washId: id,
    plateCode,
    tankCode: freeTank.code,
    detail: `${plateCode} 开洗通过，占用 ${freeTank.code}，水批 ${batchCode}，滤芯 ${filterNo}`
  });
  return { status: 201, body: { wash, gate, replay: false }, replay: false, persistIdem: true };
}

// 幂等缓存：重放必须返回首条结果
export function rememberResult(db, requestId, status, body) {
  db.idem[requestId] = {
    status,
    body: JSON.parse(JSON.stringify(body)),
    at: new Date().toISOString()
  };
}

// 2) 换水。必须由非开洗操作者执行；可借换水同时更正水批/滤芯/水源
export function changeWater(db, input) {
  const washId = required(input, "washId", "洗程");
  const operator = required(input, "operator", "换水操作者");
  const wash = db.washes.find(w => w.id === washId);
  if (!wash) throw new RuleError("not_found", "洗程不存在");
  if (wash.status !== "awaiting_water") throw new RuleError("not_awaiting", "仅待换水状态可以换水");
  if (operator === wash.openMeasure.operator) {
    throw new RuleError("operator_conflict", "换水必须由开洗操作者之外的另一人执行");
  }

  const now = new Date().toISOString();
  const patch = {};
  if (input.batchCode !== undefined && String(input.batchCode).trim()) patch.batchCode = String(input.batchCode).trim();
  if (input.filterNo !== undefined && String(input.filterNo).trim()) patch.filterNo = String(input.filterNo).trim();
  if (input.waterSource !== undefined && String(input.waterSource).trim()) patch.source = String(input.waterSource).trim();

  const last = currentVersion(wash);
  const changed = Object.keys(patch).some(k =>
    (k === "batchCode" && patch.batchCode !== last.batchCode) ||
    (k === "filterNo" && patch.filterNo !== last.filterNo) ||
    (k === "source" && patch.source !== last.source)
  );
  if (changed) snapshotVersions(wash, patch);

  const version = currentVersion(wash);
  version.episodes.push({ changedAt: now, changedBy: operator, samples: [] });
  logHistory(wash, now, "water_change",
    `${operator} 换水${changed ? `，改用 水批 ${version.batchCode} / 滤芯 ${version.filterNo} / 水源 ${version.source}（旧版只读）` : ""}`);
  addEvent(db, {
    type: "water_change",
    washId: wash.id,
    plateCode: wash.plateCode,
    detail: `${wash.plateCode} 由 ${operator} 换水，等待连续取样`
  });
  return wash;
}

// 3) 取样：另一人、隔半小时、连续两次
export function addSample(db, input) {
  const washId = required(input, "washId", "洗程");
  const operator = required(input, "operator", "取样操作者");
  const wash = db.washes.find(w => w.id === washId);
  if (!wash) throw new RuleError("not_found", "洗程不存在");
  if (wash.status !== "awaiting_water") throw new RuleError("not_awaiting", "仅待换水状态可以取样");
  if (operator === wash.openMeasure.operator) {
    throw new RuleError("operator_conflict", "取样必须由开洗操作者之外的另一人执行");
  }
  const episode = currentEpisode(wash);
  if (!episode) throw new RuleError("no_water_change", "请先登记换水，再取样");

  const silver = num(input, "silver", "银离子");
  const diffPressure = num(input, "diffPressure", "压差");

  const at = input.at ? new Date(input.at).getTime() : Date.now();
  if (Number.isNaN(at)) throw new RuleError("bad_request", "取样时间格式不正确");
  if (at < new Date(episode.changedAt).getTime() - 1000) {
    throw new RuleError("sample_too_early", "取样时间不能早于换水时间");
  }
  const sinceChange = at - new Date(episode.changedAt).getTime();
  if (episode.samples.length === 0 && sinceChange < SAMPLE_INTERVAL_MS - 60_000) {
    throw new RuleError("sample_too_early", "换水后需隔半小时才能取第一个样");
  }
  const prev = episode.samples[episode.samples.length - 1];
  if (prev) {
    const gap = at - new Date(prev.at).getTime();
    if (gap < SAMPLE_INTERVAL_MS - 60_000) {
      throw new RuleError("sample_too_early", "连续取样需间隔至少半小时");
    }
  }

  const sample = {
    at: new Date(at).toISOString(),
    operator,
    silver,
    diffPressure,
    ok: silver <= SILVER_RELEASE_MAX && diffPressure <= DIFF_PRESSURE_MAX
  };
  episode.samples.push(sample);
  const version = currentVersion(wash);
  logHistory(wash, sample.at, "sample",
    `${operator} 取样：银离子 ${silver} mg/L、压差 ${diffPressure} kPa（v${version.version}）`);
  addEvent(db, {
    type: "sample",
    washId: wash.id,
    plateCode: wash.plateCode,
    detail: `${wash.plateCode} 取样 银 ${silver} / 压差 ${diffPressure}`
  });
  return { wash, releaseCheck: releaseCheck(wash) };
}

// 放行判定（不占槽，只看数据）
export function releaseCheck(wash) {
  const version = currentVersion(wash);
  const episode = version.episodes[version.episodes.length - 1];
  if (!episode || episode.samples.length < REQUIRED_SAMPLES) {
    return { canRelease: false, reason: "continuous samples insufficient" };
  }
  const recent = episode.samples.slice(-REQUIRED_SAMPLES);
  const bad = recent.filter(s => s.silver > SILVER_RELEASE_MAX || s.diffPressure > DIFF_PRESSURE_MAX);
  if (bad.length) {
    return { canRelease: false, reason: "silver or differential pressure exceeds limits" };
  }
  return { canRelease: true, reason: null, samples: recent };
}

// 4) 放行：判定通过后才占洗槽、正式开洗
export function releaseWash(db, input) {
  const washId = required(input, "washId", "洗程");
  const wash = db.washes.find(w => w.id === washId);
  if (!wash) throw new RuleError("not_found", "洗程不存在");
  if (wash.status !== "awaiting_water") throw new RuleError("not_awaiting", "仅待换水状态可以放行");

  const version = currentVersion(wash);
  const batch = getBatch(db, version.batchCode);
  if (!batch || dayEnd(batch.expiresAt) < Date.now()) {
    throw new RuleError("water_expired", FAIL_REASONS.water_expired);
  }
  const occupier = filterOccupiedBy(db, version.filterNo, wash.id);
  if (occupier) {
    throw new RuleError("filter_occupied", `滤芯已被 ${occupier.plateCode}（${occupier.id}）占用`);
  }
  const check = releaseCheck(wash);
  if (!check.canRelease) {
    throw new RuleError("release_not_ready", "连续两次取样未全部达标，不能放行", check);
  }

  const freeTank = db.tanks.find(t =>
    !db.washes.some(w => w.status === "washing" && w.tankCode === t.code)
  );
  if (!freeTank) throw new RuleError("no_free_tank", "没有空闲洗槽，稍后重试");

  const now = new Date().toISOString();
  wash.status = "washing";
  wash.tankCode = freeTank.code;
  wash.startedAt = now;
  wash.release = {
    version: version.version,
    samples: check.samples,
    releasedAt: now,
    releasedBy: check.samples[1].operator
  };
  logHistory(wash, now, "release",
    `残留放行：连续两次银离子≤${SILVER_RELEASE_MAX}mg/L、压差≤${DIFF_PRESSURE_MAX}kPa，占用 ${freeTank.code}`);
  addEvent(db, {
    type: "release",
    washId: wash.id,
    plateCode: wash.plateCode,
    tankCode: freeTank.code,
    detail: `${wash.plateCode} 换水残留放行，占用 ${freeTank.code}`
  });
  return wash;
}

// 5) 洗片结束：释放洗槽与滤芯
export function finishWash(db, input) {
  const washId = required(input, "washId", "洗程");
  const operator = required(input, "operator", "操作者");
  const wash = db.washes.find(w => w.id === washId);
  if (!wash) throw new RuleError("not_found", "洗程不存在");
  if (wash.status === "finished") throw new RuleError("already_finished", "洗程已结束");
  const now = new Date().toISOString();
  wash.status = "finished";
  wash.finishedAt = now;
  logHistory(wash, now, "finish", `${operator} 确认洗片结束，释放 ${wash.tankCode}`);
  addEvent(db, {
    type: "finish",
    washId: wash.id,
    plateCode: wash.plateCode,
    detail: `${wash.plateCode} 洗片结束，${wash.tankCode} 释放`
  });
  return wash;
}

// 6) 更正水批/滤芯/水源：放行失效、旧版只读、回到待换水重算
export function correctWash(db, input) {
  const washId = required(input, "washId", "洗程");
  const operator = required(input, "operator", "更正操作者");
  const keys = {};
  if (input.batchCode !== undefined && String(input.batchCode).trim()) keys.batchCode = String(input.batchCode).trim();
  if (input.filterNo !== undefined && String(input.filterNo).trim()) keys.filterNo = String(input.filterNo).trim();
  if (input.waterSource !== undefined && String(input.waterSource).trim()) keys.source = String(input.waterSource).trim();
  if (!Object.keys(keys).length) {
    throw new RuleError("bad_request", "至少更正水批、滤芯或水源中的一项");
  }

  const wash = db.washes.find(w => w.id === washId);
  if (!wash) throw new RuleError("not_found", "洗程不存在");

  const last = currentVersion(wash);
  const changed = (keys.batchCode && keys.batchCode !== last.batchCode) ||
    (keys.filterNo && keys.filterNo !== last.filterNo) ||
    (keys.source && keys.source !== last.source);
  if (!changed) throw new RuleError("no_change", "更正内容与当前版本一致");

  const wasReleased = Boolean(wash.release) || wash.status === "washing";
  const oldTank = wash.tankCode;
  const now = new Date().toISOString();

  snapshotVersions(wash, keys);
  wash.status = "awaiting_water";
  wash.tankCode = null;
  wash.startedAt = null;
  wash.pastReleases ||= [];
  if (wash.release) {
    // 旧放行归档只读，不删除
    wash.release.invalidatedAt = now;
    wash.release.invalidatedBy = operator;
    wash.release.invalidReason = "更正水批/滤芯/水源，放行失效";
    wash.pastReleases.push(wash.release);
    wash.release = null;
  }
  logHistory(wash, now, "correct",
    `${operator} 更正为 水批 ${wash.batchCode} / 滤芯 ${wash.filterNo} / 水源 ${wash.waterSource}；` +
    `${wasReleased ? `原放行失效、释放 ${oldTank}，` : ""}旧版只读，回到待换水重算`);
  addEvent(db, {
    type: "correct",
    washId: wash.id,
    plateCode: wash.plateCode,
    detail: `${wash.plateCode} 更正水批/滤芯/水源（v${currentVersion(wash).version}），放行失效重算`
  });
  return wash;
}

// 7) 重算：用当前版本数据重新跑开洗四闸
export function recomputeWash(db, washId) {
  const wash = db.washes.find(w => w.id === washId);
  if (!wash) throw new RuleError("not_found", "洗程不存在");
  if (wash.status !== "awaiting_water") {
    return { wash, gate: null, note: "仅待换水状态需要重算" };
  }
  const version = currentVersion(wash);
  const gate = evaluateGate(db, {
    batchCode: version.batchCode,
    filterNo: version.filterNo,
    silver: wash.openMeasure.silver,
    conductivity: wash.openMeasure.conductivity
  }, { excludeWashId: wash.id });
  return { wash, gate };
}
