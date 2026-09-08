#!/usr/bin/env node
/**
 * sync-fallback.mjs — 把 data/curated.json 同步进 index.html 的 FALLBACK_ANIME
 *
 * 为什么需要：index.html 内嵌一份精编数据用于离线兜底，它是 curated.json 的手工副本，
 * 两者容易漂移（改了一处忘了另一处）。本脚本以 curated.json 为唯一真源重写兜底数据。
 *
 * 用法：npm run sync-fallback
 * 建议在编辑 curated.json 之后、提交之前运行一次。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = path.join(root, "index.html");
const curated = JSON.parse(fs.readFileSync(path.join(root, "data/curated.json"), "utf-8"));

// 兜底只需要展示所需字段，去掉 fetch 阶段才产生的富化字段
const FIELDS = ["id", "title", "en", "year", "studio", "eps", "type", "tags", "score", "summary", "verdict"];
const slim = curated.map((a) => {
  const o = {};
  for (const k of FIELDS) if (a[k] !== undefined) o[k] = a[k];
  return o;
});
const json = JSON.stringify(slim);

let html = fs.readFileSync(htmlPath, "utf-8");
const re = /const FALLBACK_ANIME = \[[\s\S]*?\];/;
if (!re.test(html)) {
  console.error("✗ 未在 index.html 中找到 FALLBACK_ANIME");
  process.exit(1);
}
const before = html.match(re)[0];
html = html.replace(re, `const FALLBACK_ANIME = ${json};`);
fs.writeFileSync(htmlPath, html, "utf-8");

console.log(`✓ FALLBACK_ANIME 已同步：${slim.length} 条（${before.length} → ${json.length} 字符）`);
