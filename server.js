import http from "node:http";
import { Store } from "./store.js";
import { createApiRouter } from "./routes.js";
import { page } from "./page.js";

const port = Number(process.env.PORT || 3040);
const store = new Store(process.env.WASH_DB);

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page());
    }
    const raw = await readRaw(req);
    // 入口层只需要 method 与可异步迭代的 body
    const apiReq = {
      method: req.method,
      async *[Symbol.asyncIterator]() {
        if (raw.length) yield raw;
      }
    };
    const apiRoute = createApiRouter(store);
    return await apiRoute(apiReq, res, url, send);
  } catch (error) {
    if (!res.headersSent) send(res, error instanceof SyntaxError ? 400 : 500, { error: error.message });
  }
});

store.init().then(() => {
  server.listen(port, () => console.log("蓝晒洗水回用与残留放行 listening on http://localhost:" + port));
});
