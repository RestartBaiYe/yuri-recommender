#!/usr/bin/env node
/**
 * fetch.mjs — AniList 数据更新脚本
 *
 * 职责：
 *  1. 读取 data/curated.json（手工精编，含五维评分）
 *  2. 逐部调用 AniList GraphQL 按标题搜索，富化出：
 *       - anilistId / cover（封面 URL）/ meanScore（社区均分）/ popularity（人气）
 *       - seasonYear / episodes / status / format（校准元数据）
 *  3. 自动收录"当季 + 下季 + 上季"的 Yuri 标签新番（curated 未收录的）
 *  4. 生成 data/anime.json（应用实际读取的数据）与 data/meta.json（更新时间等）
 *
 * 无第三方依赖（Node 18+ 自带 fetch）。本地：node scripts/fetch.mjs
 * 定时任务：见 .github/workflows/update-data.yml
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const DATA_DIR = path.join(root, "data");
const API = "https://graphql.anilist.co";
const UA = "hana-urokoto-yuri-index/1.0 (auto-update)";
const REQ_DELAY_MS = 1200; // ~50 req/min，规避 429
const MAX_RETRY = 5;

/* ------------------------------------------------------------------ */
/* 手工修正：系列多条目 / 英文名不可靠 / 易错配的条目                     */
/* ------------------------------------------------------------------ */
const OVERRIDES = {
  "gundam-witch": "Mobile Suit Gundam: The Witch from Mercury",
  "if-villainess": "The Magical Revolution of the Reincarnated Princess and the Genius Young Lady",
  "hitori-bocchi": "Hitoribocchi no Marumaru Seikatsu",
  "assault-lily": "Assault Lily Bouquet",
  "high-school-fleet": "High School Fleet",
  "uma-musume": "Uma Musume: Pretty Derby",
  "uma-musume2": "Uma Musume: Pretty Derby Season 2",
  "uma-musume3": "Uma Musume: Pretty Derby Season 3",
  "lovelive": "Love Live! School Idol Project",
  "futari-wa": "ふたりはプリキュア",
  "mahotsukai-precure": "Mahoutsukai Precure",
  "tama-yomi": "Tamayomi",
  "madoka-movie": "Mahou Shoujo Madoka☆Magica: Hangyaku no Monogatari",
  "madoka-4": "Mahou Shoujo Madoka Magica: Walpurgis no Kaiten",
  "madoka-5": "Mahou Shoujo Madoka Magica Movie 1: Hajimari no Monogatari",
  "madoka-6": "Mahou Shoujo Madoka Magica Movie 2: Eien no Monogatari",
  "hana-tsubaki": "Sono Hanabira ni Kuchizuke wo",
  "fate-illya": "Fate kaleid liner Prisma Illya",
  "gokigen": "High School Fleet: The Movie",
  "washi-usa": "Yuuki Yuuna wa Yuusha de Aru: Washio Sumi no Shou",
  "utena-movie": "Shoujo Kakumei Utena: Adolescence Mokushiroku",
  "wataten-movie": "Watashi ni Tenshi ga Maiorita!: Precious Friends",
  "yuru-camp-movie": "Yuru Camp△ Movie",
  "gu-pan-movie": "Girls und Panzer das Finale",
  "yuuki-yuna-3": "Yuuki Yuuna wa Yuusha de Aru: Dai Mankai no Shou",
  "sound-euphonium": "Hibike! Euphonium: Chikai no Finale",
  "bocchi-movie": "Bocchi the Rock! Re:",
  "hiro-no-kao": "This Monster Wants to Eat Me",
  "ga-rei-zero": "Ga-Rei Zero",
  "d4dj": "D4DJ First Mix",
  "pallete": "Ochikobore Fruit Tart",
  "kamiina-botan": "Kamiina Botan, Yoeru Sugata wa Yuri no Hana",
  "bofuri": "Itai no wa Iya nano de Bougyoryoku ni Kyokufuri Shitai to Omoimasu",
  "magia-record": "Magia Record: Mahou Shoujo Madoka☆Magica Gaiden",
  "slime-300": "Slime Taoshite 300-nen, Shiranai Uchi ni Level MAX ni Nattemashita",
  "vtuber-legend": "VTuber nanda ga Haishin Kiri Wasuretara Densetsu ni Natteta",
  "dosanko": "Dosanko Gal wa Namara Menkoi",
};

/* 直接指定 AniList ID（搜索总是被同名衍生条目抢占的情况） */
const DIRECT_IDS = {
  "akebi": 131548, // Akebi-chan no Sailor Fuku（搜索首条是衍生短篇《Akebi-chan 100 man-bu》）
};

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dice 系数相似度（token 集合） */
function simScore(a, b) {
  const ta = String(a || "").toLowerCase().match(/[a-z0-9\u3040-\u30ff]+/g) || [];
  const tb = String(b || "").toLowerCase().match(/[a-z0-9\u3040-\u30ff]+/g) || [];
  // 补充 CJK 汉字词元：早期正则只覆盖假名，纯中文标题的相似度恒为 0，导致匹配失败
  const isHan = (c) => { const n = c.codePointAt(0); return (n >= 0x3400 && n <= 0x4dbf) || (n >= 0x4e00 && n <= 0x9fff); };
  for (const ch of String(a || "")) if (isHan(ch)) ta.push(ch);
  for (const ch of String(b || "")) if (isHan(ch)) tb.push(ch);
  if (!ta.length || !tb.length) return 0;
  const sb = new Set(tb);
  let common = 0;
  for (const t of ta) if (sb.has(t)) common++;
  return (2 * common) / (ta.length + tb.length);
}

async function gql(query, variables = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 429) {
      lastErr = new Error("rate limited");
      const wait = 3000 * attempt;
      process.stderr.write(`    429 限流，等待 ${wait}ms 重试(${attempt}/${MAX_RETRY})...\n`);
      await sleep(wait);
      continue;
    }
    const json = await res.json();
    if (json.errors) {
      lastErr = new Error(json.errors.map((e) => e.message).join("; "));
      if (attempt < MAX_RETRY) {
        await sleep(1500 * attempt);
        continue;
      }
      throw lastErr;
    }
    return json.data;
  }
  throw lastErr;
}

const SEARCH_QUERY = `
query($search: String) {
  Media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
    id
    title { romaji english native }
    coverImage { extraLarge large medium }
    meanScore popularity
    seasonYear season
    episodes status format
    studios { nodes { name isAnimationStudio } }
  }
}`;

const BY_ID_QUERY = `
query($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    title { romaji english native }
    coverImage { extraLarge large medium }
    meanScore popularity
    seasonYear season
    episodes status format
    studios { nodes { name isAnimationStudio } }
  }
}`;

const SEASONAL_QUERY = `
query($season: MediaSeason, $year: Int, $perPage: Int, $page: Int) {
  Page(page: $page, perPage: $perPage) {
    media(type: ANIME, tag: "Yuri", season: $season, seasonYear: $year, sort: POPULARITY_DESC, isAdult: false) {
      id
      title { romaji english native }
      coverImage { extraLarge large }
      meanScore popularity
      seasonYear season
      episodes status format
      genres
      tags { name rank }
      studios { nodes { name isAnimationStudio } }
    }
  }
}`;

function tagRank(m, name) {
  const t = (m.tags || []).find((x) => x.name === name);
  return t ? t.rank : 0;
}

function mapMedia(m) {
  const romaji = m.title?.romaji || "";
  const english = m.title?.english || "";
  const native = m.title?.native || "";
  // 只取「动画制作公司」，避免把出品/音乐/发行方拼成一长串（如 "TROYCA / AT-X / Sony Music..."）
  const studioNodes = (m.studios?.nodes || []).filter((s) => s && s.name);
  const primaryStudio = studioNodes.find((s) => s.isAnimationStudio) || studioNodes[0];
  const studio = primaryStudio ? primaryStudio.name : "";
  return {
    anilistId: m.id,
    romaji,
    english,
    native,
    cover: m.coverImage?.large || m.coverImage?.extraLarge || m.coverImage?.medium || null,
    meanScore: m.meanScore ?? null,
    popularity: m.popularity ?? 0,
    seasonYear: m.seasonYear ?? null,
    season: m.season ?? null,
    episodes: m.episodes ?? null,
    status: m.status ?? null,
    format: m.format ?? null,
    studio,
    genres: m.genres || [],
    yuriRank: tagRank(m, "Yuri"),
    maleProtRank: tagRank(m, "Male Protagonist"),
    heteroRank: tagRank(m, "Heterosexual"),
    femaleCastRank: tagRank(m, "Primarily Female Cast"),
    femaleProtRank: tagRank(m, "Female Protagonist"),
    cgdctRank: tagRank(m, "Cute Girls Doing Cute Things"),
  };
}

// 自动收录的“是否真百合”判定：AniList 的 Yuri 标签很宽泛，需结合相关度与 cast 结构客观过滤
// 1) Yuri 标签相关度需≥40；2) 排除男主/异性恋主导；3) 需具备全女cast或女女恋爱信号
const AUTO_BLOCK_IDS = new Set([
  202102, // NEEDY GIRL OVERDOSE：单人主播心理剧，无女女关系
]);
function isYuriAuto(m) {
  if (AUTO_BLOCK_IDS.has(m.anilistId)) return false;
  if (m.yuriRank < 40) return false;
  if (m.maleProtRank >= 60 || m.heteroRank >= 70) return false;
  const romance = (m.genres || []).includes("Romance");
  const femaleEnsemble = m.femaleCastRank >= 70 || m.cgdctRank >= 70;
  const femaleRomance = romance && m.femaleProtRank >= 80;
  const strongYuri = m.yuriRank >= 60 && (m.femaleCastRank >= 50 || m.femaleProtRank >= 80 || romance || (m.genres || []).includes("Mahou Shoujo") || (m.genres || []).includes("Slice of Life"));
  return femaleEnsemble || femaleRomance || strongYuri;
}

function formatToType(f) {
  switch (f) {
    case "MOVIE": return "剧场";
    case "TV": return "TV";
    case "TV_SHORT": return "TV";
    case "OVA": return "OVA";
    case "ONA": return "ONA";
    case "SPECIAL": return "SP";
    default: return f || "TV";
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  const curatedPath = path.join(DATA_DIR, "curated.json");
  const animePath = path.join(DATA_DIR, "anime.json");
  const metaPath = path.join(DATA_DIR, "meta.json");
  const curated = JSON.parse(fs.readFileSync(curatedPath, "utf-8"));
  const INCREMENTAL = process.argv.includes("--incremental");
  console.log(`[1/3] 读取 curated：${curated.length} 部${INCREMENTAL ? "（增量模式）" : ""}`);

  // 增量模式：已成功富化（有 anilistId 且封面）且不在 OVERRIDES 中的条目直接复用
  const prevById = new Map();
  // 始终加载上期结果：增量模式用于跳过已成功条目；全量模式用于“防回退”（本次抓取失败时沿用上期）
  if (fs.existsSync(animePath)) {
    const prev = JSON.parse(fs.readFileSync(animePath, "utf-8"));
    for (const p of prev) if (p.source === "curated") prevById.set(p.id, p);
  }

  /* ----- 逐部富化 ----- */
  const enriched = [];
  const unmatched = [];
  let i = 0;
  let reused = 0;
  let recovered = 0;
  for (const item of curated) {
    i++;
    if (INCREMENTAL && !OVERRIDES[item.id] && prevById.has(item.id) && prevById.get(item.id).cover) {
      enriched.push(prevById.get(item.id));
      reused++;
      continue;
    }

    const candidates = [];
    if (OVERRIDES[item.id]) candidates.push(OVERRIDES[item.id]);
    if (item.en) candidates.push(item.en);
    if (item.title) candidates.push(item.title);

    let matched = null;
    let bestSim = 0;
    // 直查 ID：绕过搜索，直接按已知 ID 拉取
    if (DIRECT_IDS[item.id] != null) {
      try {
        const data = await gql(BY_ID_QUERY, { id: DIRECT_IDS[item.id] });
        const m = data?.Media;
        if (m) {
          matched = { ...item, ...mapMedia(m), sim: 1 };
          bestSim = 1;
        }
      } catch (e) {
        process.stderr.write(`    直查失败 ${item.id}: ${e.message}\n`);
      }
    }
    if (!matched) for (const cand of candidates) {
      if (cand.length < 2) continue;
      let data;
      try {
        data = await gql(SEARCH_QUERY, { search: cand });
      } catch (e) {
        process.stderr.write(`    查询失败 ${item.id}(${cand}): ${e.message}\n`);
        continue;
      }
      const m = data?.Media;
      if (!m) continue;
      const mm = mapMedia(m);
      const sim = Math.max(simScore(mm.romaji, cand), simScore(mm.english, cand), simScore(mm.native, cand));
      if (sim > bestSim) {
        bestSim = sim;
        matched = { ...item, ...mm, sim };
      }
      if (sim >= 0.8) break;
    }

    if (matched && matched.sim >= 0.55) {
      const { sim, ...clean } = matched;
      enriched.push({ ...clean, source: "curated", type: item.type });
      const flag = sim < 0.75 ? `(中置信 ${sim.toFixed(2)})` : "";
      process.stdout.write(`  ✓ ${item.id} -> #${matched.anilistId} ${matched.romaji} ${flag}\n`);
    } else {
      const prev = prevById.get(item.id);
      if (prev && prev.anilistId && prev.cover) {
        // 本次因限流/网络未匹配到，但上期有成功数据 → 沿用上期，避免数据回退
        enriched.push(prev);
        recovered++;
        process.stdout.write(`  ↺ ${item.id} 本次未匹配，沿用上期 #${prev.anilistId}（bestSim=${bestSim.toFixed(2)}）\n`);
      } else {
        unmatched.push({ id: item.id, title: item.title, en: item.en, bestSim: bestSim.toFixed(2) });
        process.stdout.write(`  ✗ ${item.id} 未匹配（bestSim=${bestSim.toFixed(2)}）\n`);
        enriched.push({ ...item, source: "curated", cover: null, meanScore: null, popularity: 0, anilistId: null });
      }
    }
    await sleep(REQ_DELAY_MS);
  }
  console.log(`[2/3] curated 富化完成：成功 ${enriched.filter((e) => e.anilistId).length}/${enriched.length}，未匹配 ${unmatched.length}${reused ? `，增量复用 ${reused}` : ""}${recovered ? `，防回退沿用 ${recovered}` : ""}`);

  /* ----- 自动收录当季 / 下季 / 上季 Yuri 新番 ----- */
  const now = new Date();
  const curYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth() + 1;
  const seasonOf = (m) => (m >= 4 && m <= 6 ? "SPRING" : m >= 7 && m <= 9 ? "SUMMER" : m >= 10 && m <= 12 ? "FALL" : "WINTER");
  const nextOf = (s) => ({ WINTER: "SPRING", SPRING: "SUMMER", SUMMER: "FALL", FALL: "WINTER" }[s]);
  const prevOf = (s) => ({ WINTER: "FALL", SPRING: "WINTER", SUMMER: "SPRING", FALL: "SUMMER" }[s]);

  const curSeason = seasonOf(curMonth);
  const curSeasonYear = curYear;
  let nextSeasonYear = curYear;
  let nextSeason = nextOf(curSeason);
  if (nextSeason === "WINTER") nextSeasonYear = curYear + 1;
  let prevSeasonYear = curYear;
  let prevSeason = prevOf(curSeason);
  if (prevSeason === "FALL") prevSeasonYear = curYear - 1;

  console.log(`[3/3] 自动收录季度：${prevSeason} ${prevSeasonYear} / ${curSeason} ${curSeasonYear} / ${nextSeason} ${nextSeasonYear}`);

  const knownAnilistIds = new Set(enriched.map((e) => e.anilistId).filter(Boolean));
  const autoAdd = [];
  const queries = [
    { season: curSeason, year: curSeasonYear },
    { season: nextSeason, year: nextSeasonYear },
    { season: prevSeason, year: prevSeasonYear },
  ];

  for (const q of queries) {
    let page = 1;
    let got = 0;
    for (;;) {
      let data;
      try {
        data = await gql(SEASONAL_QUERY, { season: q.season, year: q.year, perPage: 25, page });
      } catch (e) {
        process.stderr.write(`    季度查询失败 ${q.season} ${q.year}: ${e.message}\n`);
        break;
      }
      const list = data?.Page?.media || [];
      if (list.length === 0) break;
      for (const m of list) {
        if (knownAnilistIds.has(m.id)) continue;
        const mm = mapMedia(m);
        if (mm.status === "NOT_YET_RELEASED" && q.season !== nextSeason) continue;
        if (mm.popularity < 1500 && mm.meanScore == null) continue;
        if (!isYuriAuto(mm)) {
          process.stdout.write(`    跳过非百合 #${m.id} ${mm.native || mm.romaji}（Yuri相关度${mm.yuriRank}）\n`);
          continue;
        }
        autoAdd.push(mm);
        knownAnilistIds.add(m.id);
        got++;
      }
      if (list.length < 25) break;
      page++;
      await sleep(REQ_DELAY_MS);
    }
    console.log(`  ${q.season} ${q.year}: 新增 ${got} 部`);
    await sleep(REQ_DELAY_MS);
  }

  /* 自动条目构造五维评分（诚实标注为社区数据估算） */
  const autoEntries = autoAdd.map((m) => {
    const s = m.meanScore ? m.meanScore / 10 : 6.5;
    const popDim = m.popularity > 0 ? Math.min(10, 3 + 2 * Math.log10(m.popularity + 1) / 1.5) : 5;
    const est = (f) => Math.max(1, Math.min(10, Math.round((s * f) * 2) / 2));
    const upcoming = m.status === "NOT_YET_RELEASED" || (m.seasonYear === nextSeasonYear && m.season === nextSeason);
    const titleZh = m.native || m.romaji || m.english || "未命名新番";
    const titleEn = m.english || m.romaji || "";
    return {
      id: `anilist-${m.anilistId}`,
      title: titleZh,
      en: titleEn,
      year: m.seasonYear || new Date().getFullYear(),
      studio: m.studio || "—",
      eps: m.episodes ?? null,
      type: formatToType(m.format),
      tags: upcoming ? ["新番", "自动收录", "Yuri"] : ["自动收录", "Yuri"],
      score: [est(0.95), est(0.95), est(0.9), 7, Math.round(popDim * 2) / 2],
      summary: upcoming
        ? `AniList 自动收录的 ${m.seasonYear} 年 ${m.season ? m.season.toLowerCase() : ""}季 Yuri 新番（社区均分 ${m.meanScore ? (m.meanScore / 10).toFixed(1) : "—"}）。评分维度为基于社区数据的估计值。`
        : `AniList 自动收录的 Yuri 作品（社区均分 ${m.meanScore ? (m.meanScore / 10).toFixed(1) : "—"}）。评分维度为基于社区数据的估计值。`,
      verdict: `社区均分 ${m.meanScore ? (m.meanScore / 10).toFixed(1) : "暂无"} / 10，人气 ${m.popularity.toLocaleString()}。详情见 AniList。`,
      anilistId: m.anilistId,
      cover: m.cover,
      meanScore: m.meanScore,
      popularity: m.popularity,
      source: "auto",
    };
  });
  console.log(`自动收录合计 ${autoEntries.length} 部`);

  /* ----- 写入输出 ----- */
  const all = [...enriched, ...autoEntries];
  fs.writeFileSync(animePath, JSON.stringify(all, null, 2), "utf-8");
  fs.writeFileSync(metaPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: all.length,
    curatedCount: enriched.length,
    autoCount: autoEntries.length,
    currentSeason: `${curSeason} ${curSeasonYear}`,
    unmatched,
  }, null, 2), "utf-8");

  console.log(`\n✅ 完成：data/anime.json 共 ${all.length} 部（手工 ${enriched.length} + 自动 ${autoEntries.length}）`);
  console.log(`   封面可用 ${all.filter((e) => e.cover).length}/${all.length} 部`);
  if (unmatched.length) {
    console.log(`\n⚠️ ${unmatched.length} 条未匹配，请人工核对并在 OVERRIDES 中补充:`);
    for (const u of unmatched) console.log(`   - ${u.id} (${u.title} / ${u.en}) bestSim=${u.bestSim}`);
  }
}

main().catch((e) => {
  console.error("运行失败:", e);
  process.exit(1);
});
