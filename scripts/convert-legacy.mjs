#!/usr/bin/env node
/**
 * convert-legacy.mjs
 * 一次性工具：从旧版单文件 yuri-recommender.html 中抽取硬编码的 ANIME 数组，
 * 生成 data/curated.json（本项目手工精编数据的唯一来源）。
 *
 * 用法：node scripts/convert-legacy.mjs <legacy.html> [--out data/curated.json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const legacyPath = process.argv[2];
const outPath = process.argv.includes("--out")
  ? path.resolve(root, process.argv[process.argv.indexOf("--out") + 1])
  : path.join(root, "data", "curated.json");

if (!legacyPath || !fs.existsSync(legacyPath)) {
  console.error("用法: node scripts/convert-legacy.mjs <legacy.html> [--out path]");
  process.exit(1);
}

const html = fs.readFileSync(legacyPath, "utf-8");

// 定位 const ANIME = [ ... ];
const startMarker = "const ANIME = [";
const start = html.indexOf(startMarker);
if (start === -1) {
  console.error("未在文件中找到 ANIME 数组定义");
  process.exit(1);
}
const bodyStart = start + startMarker.length;
// 找到匹配的数组结尾（从 bodyStart 开始扫描，遇 "];" 即结束）
const end = html.indexOf("\n];", bodyStart);
if (end === -1) {
  console.error("未找到 ANIME 数组结尾");
  process.exit(1);
}
const arrayText = html.slice(bodyStart, end);

// 用 Function 求值（内容为本项目自有数据，安全）
let list;
try {
  list = new Function(`return [${arrayText}];`)();
} catch (e) {
  console.error("解析 ANIME 数组失败:", e.message);
  process.exit(1);
}

if (!Array.isArray(list) || list.length === 0) {
  console.error("解析结果为空");
  process.exit(1);
}

// 校验每条记录的必需字段
const required = ["id", "title", "en", "year", "studio", "eps", "type", "tags", "score", "summary", "verdict"];
const bad = list.filter((a) => required.some((k) => !(k in a)) || !Array.isArray(a.score) || a.score.length !== 5);
if (bad.length) {
  console.error(`存在 ${bad.length} 条缺少必需字段/评分维度异常的记录:`, bad.map((a) => a.id).join(", "));
  process.exit(1);
}

// 去重（README 已指出 roll-rice 是 rolling-girls 的重复误录，此处保留 rolling-girls）
const seen = new Set();
const deduped = list.filter((a) => {
  if (seen.has(a.id)) {
    console.warn(`[去重] 丢弃重复 id: ${a.id}`);
    return false;
  }
  seen.add(a.id);
  return true;
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(deduped, null, 2), "utf-8");
console.log(`✅ 已生成 ${outPath}`);
console.log(`   收录 ${deduped.length} 部（原始 ${list.length}，去重 ${list.length - deduped.length} 条）`);
