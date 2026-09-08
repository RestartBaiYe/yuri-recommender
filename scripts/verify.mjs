#!/usr/bin/env node
/**
 * verify.mjs — 端到端动态校验（数据 + 前端逻辑）
 *
 * 用法：node scripts/verify.mjs
 * 与 validate.mjs 的区别：validate 只看 curated.json；本脚本会解析三个数据源、
 * 交叉比对一致性，并把 index.html 内联脚本里的评分函数抽出来实际执行一遍。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} - ${msg}`); if (!cond) fail.push(msg); };

/* ---------- 1. 三个数据源均为合法 JSON ---------- */
const curated = JSON.parse(fs.readFileSync(path.join(root, "data/curated.json"), "utf-8"));
const anime = JSON.parse(fs.readFileSync(path.join(root, "data/anime.json"), "utf-8"));
const meta = JSON.parse(fs.readFileSync(path.join(root, "data/meta.json"), "utf-8"));
const html = fs.readFileSync(path.join(root, "index.html"), "utf-8");
const fallback = JSON.parse(html.match(/const FALLBACK_ANIME = (\[[\s\S]*?\]);/)[1]);
ok(true, "curated.json / anime.json / meta.json / index.html 兜底 均为合法 JSON");

/* ---------- 2. 条目数与交叉一致性 ---------- */
const autoCount = anime.filter((x) => x.source === "auto").length;
console.log(`\n条目数：curated=${curated.length}  anime=${anime.length}(auto ${autoCount})  fallback=${fallback.length}`);
ok(anime.length === curated.length + autoCount, "anime.json = curated + 自动收录");
ok(fallback.length === curated.length, "index.html 兜底与 curated 数量一致");
ok(meta.curatedCount === curated.length, `meta.curatedCount 与 curated 一致（${meta.curatedCount}）`);

/* ---------- 3. 已清理的条目不应残留 ---------- */
const BANNED = ["nettaigyo", "kunlun", "sae", "akebi-movie", "whisper-me-movie", "yama-ai", "kase-san2", "watashi-no-koi"];
for (const [name, arr] of [["curated", curated], ["anime", anime], ["fallback", fallback]]) {
  const hit = arr.filter((x) => BANNED.includes(x.id)).map((x) => x.id);
  ok(hit.length === 0, `${name} 无已删除条目${hit.length ? "：" + hit.join(",") : ""}`);
}

/* ---------- 4. id 唯一 / 无占位标题 / 评分合法 ---------- */
// 占位标题检测：半角 ? 结尾（如「玻璃地球?」），或全角 ？ 结尾但整条标题没有中日文字符。
// 合法的日式/中文标题（「请问您今天要来点兔子吗？」）用全角 ？，不应误判。
const isPlaceholderTitle = (t) => {
  const s = String(t || "");
  if (/\?\s*$/.test(s)) return true;
  return /？\s*$/.test(s) && !/[぀-ヿ㐀-䶿一-鿿]/.test(s);
};

for (const [name, arr] of [["curated", curated], ["anime", anime], ["fallback", fallback]]) {
  const ids = arr.map((x) => x.id);
  ok(new Set(ids).size === ids.length, `${name} id 唯一`);
  const ph = arr.filter((x) => isPlaceholderTitle(x.title)).map((x) => x.title);
  ok(ph.length === 0, `${name} 无占位标题${ph.length ? "：" + ph.join(",") : ""}`);
  const bad = arr.filter((x) => !Array.isArray(x.score) || x.score.length !== 5 || x.score.some((n) => typeof n !== "number" || n < 0 || n > 10));
  ok(bad.length === 0, `${name} 五维评分均在 0–10${bad.length ? "：" + bad.map((x) => x.id).join(",") : ""}`);
}

/* ---------- 5. index.html 内联脚本语法 ---------- */
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
let syntaxOK = true;
try { new Function(script); } catch (e) { syntaxOK = false; console.log("  语法错误：" + e.message); }
ok(syntaxOK, "index.html 内联 JS 语法正确");

/* ---------- 6. 抽取评分函数并实际执行 ---------- */
const grab = (name) => {
  const m = script.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`, "m"));
  if (!m) throw new Error("未找到函数 " + name);
  return m[0];
};
const ctx = new Function(`
  const clamp = (n,a,b)=>Math.min(b,Math.max(a,n));
  const round1 = n => Math.round(n*10)/10;
  let weights = [30,30,20,10,10];
  let myRatings = {};
  ${grab("hotDim")}
  ${grab("dimScore")}
  ${grab("recScore")}
  return { hotDim, dimScore, recScore, weights, myRatings };
`)();

const high = { id: "h", score: [10, 10, 10, 10, 10], meanScore: 80, popularity: 100000 };
const low = { id: "l", score: [1, 1, 1, 1, 1], meanScore: null, popularity: 0 };
const rh = ctx.recScore(high), rl = ctx.recScore(low);
ok(rh > rl, `加权评分能正确区分优劣（${rh} > ${rl}）`);
ok(rh <= 10 && rl >= 0, "评分落在 0–10 区间");
ctx.myRatings["l"] = 10;
const rl2 = ctx.recScore(low);
ok(rl2 > rl, `「我的评分」影响热门程度维度（${rl} → ${rl2}）`);

/* ---------- 7. 封面兜底逻辑 ---------- */
// 这两个函数没有嵌套花括号，用简单正则单独抽取（grab 是为多行函数写的）
const coverSrc = [
  script.match(/function anilistCoverUrl\([\s\S]*?\}/)[0],
  script.match(/function getCoverUrl\([\s\S]*?\}/)[0],
].join("\n");
const coverCtx = new Function(`${coverSrc}\nreturn { getCoverUrl };`)();
ok(coverCtx.getCoverUrl({ cover: "https://s4.anilist.co/x.jpg", anilistId: 1 }) === "https://s4.anilist.co/x.jpg", "有 AniList 封面时优先使用它");
ok(coverCtx.getCoverUrl({ cover: null, anilistId: 101573 }) === "https://img.anili.st/media/101573", "缺封面但有 ID 时用 img.anili.st 兜底");
ok(coverCtx.getCoverUrl({ cover: null, anilistId: null }) === null, "既无封面也无 ID 时返回 null（交给渐变兜底）");

/* ---------- 8. 自动收录条目字段完整 ---------- */
const autoBad = anime.filter((x) => x.source === "auto" && (!x.id || !x.title || !Array.isArray(x.score)));
ok(autoBad.length === 0, `自动收录条目字段完整（${autoCount} 条）`);

console.log(`\n${fail.length === 0 ? "✅ 全部通过" : "❌ " + fail.length + " 项失败"}`);
process.exit(fail.length ? 1 : 0);
