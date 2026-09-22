// 存储层：洗水回用模块的 JSON 文件持久化与基础数据访问
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "water-reuse.json");

// 今天按 2026-09-22 计：WB-2601/WB-2511 未过期，WB-2510 已过期
export const seed = {
  seq: 1,
  tanks: [
    { code: "洗槽-1" },
    { code: "洗槽-2" },
    { code: "洗槽-3" }
  ],
  waterBatches: [
    { code: "WB-2601", source: "井水过滤", expiresAt: "2026-12-31" },
    { code: "WB-2511", source: "自来水", expiresAt: "2026-10-15" },
    { code: "WB-2510", source: "山泉水", expiresAt: "2026-09-01" }
  ],
  washes: [],
  events: [],
  idem: {}
};

let cache = null;

export async function loadDb() {
  if (cache) return cache;
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  cache = JSON.parse(await readFile(dbPath, "utf8"));
  cache.tanks ||= seed.tanks;
  cache.waterBatches ||= seed.waterBatches;
  cache.washes ||= [];
  cache.events ||= [];
  cache.idem ||= {};
  cache.seq ||= 1;
  return cache;
}

export async function saveDb() {
  await writeFile(dbPath, JSON.stringify(cache, null, 2));
}

// 仅供测试重置内存态
export function useDb(db) { cache = db; }

export function nextId(db, prefix) {
  return `${prefix}-${String(db.seq++).padStart(4, "0")}`;
}

export function addEvent(db, event) {
  const id = nextId(db, "EV");
  const record = { id, at: new Date().toISOString(), ...event };
  db.events.unshift(record);
  return record;
}

// 洗槽占用视图：status=washing 的洗程才占槽
export function tankView(db) {
  return db.tanks.map(tank => {
    const wash = db.washes.find(w => w.status === "washing" && w.tankCode === tank.code);
    return {
      code: tank.code,
      occupied: Boolean(wash),
      washId: wash ? wash.id : null,
      plateCode: wash ? wash.plateCode : null,
      filterNo: wash ? wash.filterNo : null,
      operator: wash ? wash.startOperator : null,
      startedAt: wash ? wash.startedAt : null
    };
  });
}
