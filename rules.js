// 判定层：洗水回用与残留放行的全部业务规则（纯函数，无 I/O）
export const SILVER_LIMIT_START = 0.5; // 开洗银离子上限 mg/L
export const SILVER_LIMIT_RELEASE = 0.1; // 放行银离子上限 mg/L
export const CONDUCTIVITY_LIMIT = 800; // 电导率上限 µS/cm
export const PRESSURE_LIMIT = 10; // 滤芯压差上限 kPa
export const SAMPLE_GAP_MS = 30 * 60 * 1000; // 两次取样最小间隔 30 分钟

// 水批判定：必须已登记且未过期（按本地日历日期比较）
export function checkWaterBatch(waterBatch, todayStr) {
  if (!waterBatch) return `水批未登记`;
  if (waterBatch.expiry < todayStr) return `水批已过期（${waterBatch.code} 到期 ${waterBatch.expiry}）`;
  return null;
}

// 开洗判定：返回 { ok, reasons }；不通过时只转待换水、不占洗槽
export function evaluateStart(input, ctx) {
  const reasons = [];
  const batchIssue = checkWaterBatch(ctx.waterBatch, ctx.todayStr);
  if (batchIssue) reasons.push(batchIssue);
  if (Number(input.silverIon) > SILVER_LIMIT_START)
    reasons.push(`银离子 ${input.silverIon} 高于 ${SILVER_LIMIT_START} mg/L`);
  if (Number(input.conductivity) > CONDUCTIVITY_LIMIT)
    reasons.push(`电导率 ${input.conductivity} 超过 ${CONDUCTIVITY_LIMIT} µS/cm`);
  if (ctx.filterOccupant)
    reasons.push(`滤芯 ${input.filterNo} 正被 ${ctx.filterOccupant.negativeCode}（${ctx.filterOccupant.id}）占用`);
  return { ok: reasons.length === 0, reasons };
}

// 取样登记前的单次校验：另一人、隔半小时
export function checkSample(input, wash, nowMs) {
  const at = input.at ? Date.parse(input.at) : nowMs;
  if (Number.isNaN(at)) return { error: "取样时间无法解析", sample: null };
  const operators = new Set([wash.operator]);
  if (wash.change) operators.add(wash.change.operator);
  if (operators.has(input.sampler))
    return { error: "取样人必须是开洗/换水操作者之外的另一人", sample: null };
  const last = wash.samples.length ? Date.parse(wash.samples[wash.samples.length - 1].at) : null;
  if (last !== null && at - last < SAMPLE_GAP_MS)
    return { error: "距上次取样不足 30 分钟", sample: null };
  return {
    error: null,
    sample: { at: new Date(at).toISOString(), sampler: input.sampler, silverIon: Number(input.silverIon), pressureDiff: Number(input.pressureDiff) }
  };
}

// 放行判定：最近连续 2 次取样银离子均 ≤0.1 且压差均 ≤10 kPa（早期不合格样本留痕，重测合格可覆盖）
export function evaluateRelease(wash) {
  const samples = wash.samples;
  if (samples.length < 2)
    return { ok: false, reason: `连续取样不足 2 次（当前 ${samples.length} 次）` };
  const window = samples.slice(-2);
  const badSilver = window.find(s => s.silverIon > SILVER_LIMIT_RELEASE);
  if (badSilver)
    return { ok: false, reason: `最近取样银离子 ${badSilver.silverIon} 高于 ${SILVER_LIMIT_RELEASE} mg/L，继续冲洗换水后重测` };
  const badPressure = window.find(s => s.pressureDiff > PRESSURE_LIMIT);
  if (badPressure)
    return { ok: false, reason: `最近取样滤芯压差 ${badPressure.pressureDiff} 超过 ${PRESSURE_LIMIT} kPa，更换滤芯后重测` };
  return { ok: true, reason: `最近连续 ${window.length} 次取样合格，准予放行回用` };
}

// 更正会让放行失效的字段：水批、滤芯、水源
export const CORRECTION_FIELDS = ["waterBatch", "filterNo", "waterSource"];

export function snapshotVersion(wash, operator, note) {
  return {
    version: wash.versions.length + 1,
    at: new Date().toISOString(),
    operator,
    note,
    waterBatch: wash.waterBatch,
    filterNo: wash.filterNo,
    waterSource: wash.waterSource,
    conductivity: wash.conductivity,
    silverIon: wash.silverIon,
    releasedAt: wash.releasedAt
  };
}

// 应用更正：返回 { invalidated, changes }；命中关键字段则放行失效、取样作废、重算
export function applyCorrection(wash, patch, operator) {
  const changes = [];
  for (const key of CORRECTION_FIELDS) {
    if (patch[key] !== undefined && patch[key] !== wash[key]) {
      changes.push({ field: key, from: wash[key], to: patch[key] });
    }
  }
  if (patch.conductivity !== undefined && Number(patch.conductivity) !== wash.conductivity)
    changes.push({ field: "conductivity", from: wash.conductivity, to: Number(patch.conductivity) });
  if (patch.silverIon !== undefined && Number(patch.silverIon) !== wash.silverIon)
    changes.push({ field: "silverIon", from: wash.silverIon, to: Number(patch.silverIon) });

  const invalidated = changes.some(c => CORRECTION_FIELDS.includes(c.field));
  if (!changes.length) return { invalidated: false, changes };

  wash.versions.push(snapshotVersion(wash, operator, "更正前快照"));
  for (const { field, to } of changes) wash[field] = to;

  if (invalidated) {
    wash.samples = [];
    wash.releasedAt = null;
    wash.releaseOperator = null;
    wash.change = null;
    wash.tank = null;
    wash.status = "待换水";
    wash.reasons = ["更正了水批/滤芯/水源，放行失效，需换水后重新取样"];
  }
  return { invalidated, changes };
}
