#!/usr/bin/env node
/**
 * validate.mjs — 校验 data/curated.json 的数据完整性
 *
 * 用法：node scripts/validate.mjs
 * 退出码非 0 表示存在致命问题，适合放进 CI 作为「数据守门员」，
 * 避免再次出现「标题带问号的占位条目 / id 重复 / 评分越界」等问题。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(__dirname, "..", "data", "curated.json");

const REQUIRED = ["id", "title", "year", "studio", "eps", "type", "tags", "score", "summary", "verdict"];
const errors = [];
const warnings = [];

let list;
try {
  list = JSON.parse(fs.readFileSync(file, "utf-8"));
} catch (e) {
  console.error("✗ curated.json 不是合法 JSON：", e.message);
  process.exit(1);
}
if (!Array.isArray(list)) {
  console.error("✗ curated.json 顶层应为数组");
  process.exit(1);
}

// 占位标题检测：半角 ? 结尾（如「玻璃地球?」），或全角 ？ 结尾但整条标题没有中日文字符。
// 合法的日式/中文标题（「请问您今天要来点兔子吗？」）用全角 ？，不应误判。
const isPlaceholderTitle = (t) => {
  const s = String(t || "");
  if (/\?\s*$/.test(s)) return true;
  return /？\s*$/.test(s) && !/[぀-ヿ㐀-䶿一-鿿]/.test(s);
};

const seen = new Map();
list.forEach((a, i) => {
  const at = `#${i} ${a.id || "(无 id)"}`;
  for (const k of REQUIRED) {
    if (a[k] === undefined || a[k] === null || a[k] === "") errors.push(`${at} 缺少字段 ${k}`);
  }
  if (Array.isArray(a.score)) {
    if (a.score.length !== 5) errors.push(`${at} score 应为 5 个维度，实际 ${a.score.length}`);
    if (a.score.some((n) => typeof n !== "number" || n < 0 || n > 10)) errors.push(`${at} score 存在越界值：${JSON.stringify(a.score)}`);
  }
  if (a.id) {
    if (seen.has(a.id)) errors.push(`${at} id 重复（与 ${seen.get(a.id)} 冲突）`);
    else seen.set(a.id, at);
  }
  if (isPlaceholderTitle(a.title)) errors.push(`${at} 标题疑似占位符：${a.title}`);
  if (a.verdict === "——" || a.summary === "——") warnings.push(`${at} 存在占位文本「——」`);
  if (!a.en) warnings.push(`${at} 缺少英文名，AniList 富化匹配可能失败`);
});

console.log(`curated.json：共 ${list.length} 条`);
if (warnings.length) {
  console.log(`\n⚠️ ${warnings.length} 条警告（不阻塞）：`);
  warnings.forEach((w) => console.log("  - " + w));
}
if (errors.length) {
  console.error(`\n✗ ${errors.length} 条错误：`);
  errors.forEach((e) => console.error("  - " + e));
  process.exit(1);
}
console.log("\n✓ 校验通过，无致命问题");
