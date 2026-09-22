// 服务入口：蓝晒洗水回用与残留放行模块
// 业务拆分：wash-entry.js（入口/路由/页面）、wash-rules.js（判定）、wash-store.js（存储）
import { startWashServer } from "./wash-entry.js";

const port = Number(process.env.PORT || 3040);
startWashServer(port);
