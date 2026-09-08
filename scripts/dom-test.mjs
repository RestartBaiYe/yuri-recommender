#!/usr/bin/env node
/**
 * dom-test.mjs — 用 jsdom 真实渲染 index.html 的冒烟测试
 *
 * 用法：npm test   （需先 npm install，jsdom 已列入 devDependencies）
 * 两个场景：
 *   offline — fetch 失败 → 走内置兜底数据（无封面/社区分）
 *   online  — fetch 成功（直接读本地 data/*.json）→ 走 AniList 富化数据（有封面/社区分）
 * 未安装 jsdom 时会跳过（退出码 0），不会阻断 CI。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let JSDOM;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  console.log("⚠️ 未安装 jsdom，跳过 DOM 测试（npm install 后重试）");
  process.exit(0);
}

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const results = [];
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} - ${msg}`); results.push(cond); };
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用给定的 fetch 实现跑一个场景，返回 { doc, window } */
async function boot(fetchImpl) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
  const { window } = dom;
  const noop = () => {};
  window.HTMLCanvasElement.prototype.getContext = function () {
    return new Proxy({}, { get: (t, p) => (p === "canvas" ? t : noop) });
  };
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  window.devicePixelRatio = 1;
  window.fetch = fetchImpl;
  await tick(500);
  return { window, doc: window.document };
}

/* ============ 场景一：离线兜底 ============ */
console.log("── 场景一：离线兜底 ──");
{
  const { window, doc } = await boot(() => Promise.reject(new Error("offline")));
  const errs = [];
  window.addEventListener("error", (e) => errs.push(e.message));

  ok(doc.querySelectorAll("#sliders input").length === 5, "权重滑杆渲染 5 个");
  ok(Number(doc.querySelector("#total-count").textContent) > 100, `总计数正常（${doc.querySelector("#total-count").textContent}）`);
  ok(doc.querySelectorAll(".card").length === 24, `初始渲染 24 张卡片（${doc.querySelectorAll(".card").length}）`);
  ok(doc.querySelectorAll(".card canvas").length === 24, "每张卡片都绘制了雷达图 canvas");
  ok(doc.querySelector("#update-line").textContent.includes("离线"), "离线模式提示正确");

  doc.querySelector("#load-more").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(doc.querySelectorAll(".card").length === 48, `点「展开更多」→ 48 张（${doc.querySelectorAll(".card").length}）`);

  const search = doc.querySelector("#search");
  search.value = "终将成为你";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick(260);
  ok([...doc.querySelectorAll(".card h3")].some((h) => h.textContent.includes("终将成为你")), "搜索「终将成为你」命中");
  search.value = "";
  search.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick(260);
  ok(doc.querySelectorAll(".card").length === 24, "清空搜索恢复 24 张");

  const sort = doc.querySelector("#sort");
  sort.value = "kuchisu";
  sort.dispatchEvent(new window.Event("change", { bubbles: true }));
  const first = doc.querySelector(".card h3").textContent;
  ok(["Citrus", "樱 Trick", "神无月的巫女", "惊爆草莓", "花吻在上"].some((t) => first.includes(t)), `按浓度排序首位是《${first}》`);

  const chips = () => doc.querySelectorAll("#chips .chip").length;
  const more = () => doc.querySelector("#chips .chip-more");
  ok(chips() <= 20, `标签默认折叠（${chips()} 个，≤20）`);
  ok(!!more(), "存在「更多标签」按钮");
  const collapsed = chips();
  more().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(chips() > collapsed, `点击展开（${collapsed} → ${chips()}）`);
  more().dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(chips() === collapsed, `再点收起（${chips()}）`);
  const chip = [...doc.querySelectorAll("#chips .chip")].find((c) => c.textContent === "直球");
  ok(!!chip, "存在「直球」标签芯片");
  if (chip) {
    chip.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const n = doc.querySelectorAll(".card").length;
    ok(n > 0 && n <= 24, `「直球」筛选后 ${n} 张`);
  }

  doc.querySelector(".card").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(doc.querySelector("#overlay").classList.contains("open"), "点击卡片打开详情弹窗");
  ok(doc.querySelectorAll("#modal-body .bar-row").length === 5, "弹窗内五维评分条 = 5");
  ok(!!doc.querySelector("#modal-body #radar-lg"), "弹窗内大雷达图存在");
  ok(!!doc.querySelector("#myrate"), "弹窗内「我的评分」滑杆存在");
  doc.querySelector("#modal-close").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(!doc.querySelector("#overlay").classList.contains("open"), "弹窗可关闭");

  const slider = doc.querySelectorAll("#sliders input")[3];
  slider.value = 100;
  slider.dispatchEvent(new window.Event("input", { bubbles: true }));
  ok(doc.querySelectorAll(".card").length > 0, "拖动权重滑杆后卡片仍正常渲染");
  ok(doc.querySelector("#top-pick").textContent.includes("第一位"), "面板显示「当前第一位」");
  ok(!!window.localStorage.getItem("yuri_prefs_v1"), "偏好已写入 localStorage");
  ok(errs.length === 0, `无 JS 运行时错误${errs.length ? "：" + errs.join(" | ") : ""}`);
  await tick(60); // 让遗留定时器跑完，再销毁该 window
  window.close();
}

/* ============ 场景二：联网（读取真实 data/*.json） ============ */
console.log("\n── 场景二：联网数据 ──");
{
  const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const { window, doc } = await boot(async (url) => {
    const rel = String(url).replace(/^\.?\//, "");
    if (!fs.existsSync(path.join(root, rel))) return { ok: false, json: async () => null };
    return { ok: true, json: async () => readJson(rel) };
  });
  const errs = [];
  window.addEventListener("error", (e) => errs.push(e.message));

  const anime = readJson("data/anime.json");
  ok(Number(doc.querySelector("#total-count").textContent) === anime.length, `总计数 = anime.json 条目数（${doc.querySelector("#total-count").textContent}）`);
  ok(doc.querySelector("#update-line").textContent.includes("AniList 同步"), "显示「AniList 同步」时间戳");
  ok(!doc.querySelector("#update-line").textContent.includes("离线"), "不再是离线模式");
  const withCover = [...doc.querySelectorAll(".card img")].length;
  ok(withCover > 0, `卡片渲染了封面图（${withCover} 张）`);
  const communityBadges = [...doc.querySelectorAll(".comm-badge")].length;
  ok(communityBadges > 0, `卡片显示社区均分徽章（${communityBadges} 个）`);

  // 社区均分排序
  const sort = doc.querySelector("#sort");
  sort.value = "community";
  sort.dispatchEvent(new window.Event("change", { bubbles: true }));
  ok(doc.querySelectorAll(".card").length === 24, "按社区均分排序正常渲染");

  // 弹窗显示社区数据
  doc.querySelector(".card").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const box = doc.querySelector("#modal-body .community-box");
  ok(!!box && box.textContent.includes("社区均分"), "弹窗展示社区均分");
  ok(!!box && /#\d+/.test(box.textContent), "弹窗展示 AniList ID");
  doc.querySelector("#modal-close").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok(errs.length === 0, `无 JS 运行时错误${errs.length ? "：" + errs.join(" | ") : ""}`);
  await tick(60); // 让遗留定时器跑完，再销毁该 window
  window.close();
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);
