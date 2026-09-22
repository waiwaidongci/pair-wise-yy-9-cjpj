// 存储层：洗水回用模块的唯一持久化出口（JSON 文件 + 内存缓存）
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const defaultDbPath = join(__dirname, "data", "cyanotype-wash.json");

// 初始台账：固定洗槽、水批登记（含已过期批）、一条占用洗槽的洗程与一条待换水记录
const seed = {
  tanks: ["洗槽1", "洗槽2", "洗槽3"],
  waterBatches: [
    { code: "WB-0901", source: "井水过滤", expiry: "2026-09-10" },
    { code: "WB-0920", source: "山泉沉淀", expiry: "2026-09-25" },
    { code: "WB-0922", source: "井水过滤", expiry: "2026-10-01" }
  ],
  washes: [
    {
      id: "W-1001",
      requestId: "seed-1001",
      negativeCode: "CN-001",
      tank: "洗槽1",
      waterBatch: "WB-0920",
      waterSource: "山泉沉淀",
      conductivity: 612,
      silverIon: 0.18,
      filterNo: "F-07",
      operator: "老周",
      status: "洗片中",
      reasons: [],
      startedAt: "2026-09-22T09:10:00+08:00",
      endedAt: null,
      change: null,
      samples: [],
      releasedAt: null,
      releaseOperator: null,
      versions: [],
      history: [
        { at: "2026-09-22T09:10:00+08:00", action: "开洗", note: "占用洗槽1，滤芯 F-07" }
      ]
    },
    {
      id: "W-1002",
      requestId: "seed-1002",
      negativeCode: "CN-002",
      tank: null,
      waterBatch: "WB-0901",
      waterSource: "井水过滤",
      conductivity: 540,
      silverIon: 0.62,
      filterNo: "F-08",
      operator: "阿敏",
      status: "待换水",
      reasons: ["水批已过期（WB-0901 到期 2026-09-10）", "银离子 0.62 高于 0.5 mg/L"],
      startedAt: "2026-09-22T09:22:00+08:00",
      endedAt: null,
      change: null,
      samples: [],
      releasedAt: null,
      releaseOperator: null,
      versions: [],
      history: [
        { at: "2026-09-22T09:22:00+08:00", action: "开洗", note: "判定不通过，转待换水，未占洗槽" }
      ]
    }
  ],
  // 开洗请求的幂等重放表：requestId -> 首次判定的 HTTP 状态与洗程
  results: {}
};

export class Store {
  constructor(path = defaultDbPath) {
    this.path = path;
    this.data = null;
  }

  async init() {
    if (!existsSync(this.path)) {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(seed, null, 2));
    }
    this.data = JSON.parse(await readFile(this.path, "utf8"));
    this.data.washes ||= [];
    this.data.results ||= {};
    return this.data;
  }

  // 原子落盘：同目录临时文件 + rename
  async save() {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.path);
  }

  listWashes() {
    return [...this.data.washes].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  getWash(id) {
    return this.data.washes.find(w => w.id === id) || null;
  }

  getByRequest(requestId) {
    const hit = this.data.results[requestId];
    if (!hit) return null;
    return { http: hit.http, wash: this.getWash(hit.washId) };
  }

  rememberResult(requestId, washId, http) {
    this.data.results[requestId] = { washId, http };
  }

  // 同张底片存在未终结洗程（洗片中 / 待换水 / 检测中）即视为占用中
  activeWashForNegative(negativeCode) {
    return this.data.washes.find(
      w => w.negativeCode === negativeCode && ["洗片中", "待换水", "检测中"].includes(w.status)
    ) || null;
  }

  freeTank() {
    return this.data.tanks.find(
      t => !this.data.washes.some(w => w.status === "洗片中" && w.tank === t)
    ) || null;
  }

  tankOccupant(tank) {
    return this.data.washes.find(w => w.status === "洗片中" && w.tank === tank) || null;
  }

  waterBatch(code) {
    return this.data.waterBatches.find(b => b.code === code) || null;
  }

  addWash(wash, http) {
    this.data.washes.unshift(wash);
    this.rememberResult(wash.requestId, wash.id, http);
  }

  newId() {
    return "W-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
  }
}
