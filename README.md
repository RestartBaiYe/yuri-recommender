# 花占卜 · 百合番推荐器

> HANA UROKOTO — 把滑杆推向你在意的方向：剧情、角色、画面、浓度，还是人气，近两百部百合番为你重新排序。

一个**静态、免后端、实时更新**的百合番推荐站。数据来自 AniList 社区，通过 GitHub Actions 定时同步；他人评价（AniList 社区均分/人气）会实时影响每部番的排位。

🌐 **在线地址**：[https://restartbaiye.github.io/yuri-recommender/](https://restartbaiye.github.io/yuri-recommender/)（GitHub Pages，推送 main 即自动部署）

---

## ✨ 功能亮点

| 能力 | 说明 |
|------|------|
| 🖼️ **番剧封面** | 封面优先取 AniList 高清图，失败自动降级到 MAL CDN → 渐变 + 番名首字兜底 |
| 🌐 **实时更新** | GitHub Actions 每周自动同步 AniList：补充最新季度 Yuri 新番、刷新封面与社区均分；也可手动触发 |
| 🗳️ **社区评分影响排位** | 「热门程度」维度动态融合 AniList 社区均分 × 0.35 + 社区人气 × 0.20 + 手工人气 × 0.45 |
| ⭐ **我的评分** | 详情弹窗内 1-10 打分，保存于本机 localStorage；打了分后用「我的评分」替代社区均分参与你的个人排名 |
| 🔍 **搜索 / 筛选 / 多排序** | 番名 / 标签 / 年份 / 制作公司搜索；标签芯片过滤；占卜结果 / 年份 / 名称 / 浓度 / 社区均分五种排序 |
| 📊 **五维雷达图** | 剧情、角色、作画、浓度、人气五维 + 权重滑杆实时重排 |
| 🛡️ **离线兜底** | 内置 185 部精编数据，断网也能正常使用（无封面/社区数据） |

## 🏗️ 架构

```
AniList GraphQL API（社区数据：封面 / 均分 / 人气 / 新番）
        │  每周定时（GitHub Actions：.github/workflows/update-data.yml）
        ▼
   scripts/fetch.mjs  ──►  data/anime.json  +  data/meta.json
        │                      │（应用实时读取，联网自动生效）
        ▼                      ▼
   index.html（前端）◄── 内置 data/curated.json（离线兜底）
        │
        ▼
   GitHub Pages（.github/workflows/pages.yml）
```

- **`data/curated.json`**：185 部手工精编数据（含五维主观评分、简介、评语），是推荐器的"灵魂"，需要人工维护。
- **`data/anime.json`**：由 `fetch.mjs` 生成 = curated + AniList 富化（封面/社区均分/人气）+ 自动收录的当季新番。
- **`data/meta.json`**：更新时间、收录数、当前季度等元信息。

## 🧪 本地运行

```bash
# 1. 本地预览（纯静态，浏览器打开 index.html 即可；或起一个静态服务）
npx serve .

# 2. 手动同步 AniList 数据（约 5 分钟，会自动生成 data/anime.json）
node scripts/fetch.mjs
```

> Node.js ≥ 18（自带 `fetch`，无第三方依赖）。

## 🚀 部署到 GitHub Pages

1. 把这个仓库推到 GitHub（或直接 Fork 本仓库）。
2. 仓库 **Settings → Pages**：`Source` 选 **GitHub Actions**。
3. 推送后自动触发 `pages.yml` 部署，站点地址见 Actions 运行日志 / Pages 页面。
4. 数据每周自动同步；如需立即刷新，在 **Actions → Update AniList data → Run workflow** 手动触发。

## 🗳️ 社区评分怎么影响排名

「热门程度」是动态维度：

```
热门程度 = 手工人气 × 0.45
         + AniList 社区均分/10 × 0.35   ← 其他用户（AniList 社区）的评价
         + 社区人气归一化 × 0.20        ← 人气越高越靠前
（若你打了「我的评分」，社区均分项被你的评分替代，只影响你自己的排名）
```

这意味着随着 AniList 社区打分变化，每周同步后推荐排位会随之更新——真正做到"他人评价对评分有影响"。

## 🌸 收录标准（什么算"百合番"）

为避免混入"只是女性角色多 / 双女主友情"但本质非百合的作品，只收录满足以下任一条件的番：

1. **有明确女女感情线**（真百合 / 明确ゆり，含剧场版、总集篇）；
2. **全女性主役 cast，且女女互动是核心看点之一**（轻百合 / ゆる百合，如芳文系日常、全女乐队/偶像/社团番）。

**不收录**：男主或男性视角主角、异性恋主线、男性向后宫、伪百合（男扮女装男主），以及纯男女混合友情/搞笑且无女女刻画的作品。手工库按此标准人工把关；自动收录由 `isYuriAuto()` 按 AniList 标签相关度客观过滤。

## 🔧 如何维护与扩展

- **新增/修正番剧**：编辑 `data/curated.json`，然后运行 `node scripts/fetch.mjs` 重新生成 `anime.json`。
- **修正匹配错误的番剧**：在 `scripts/fetch.mjs` 的 `OVERRIDES` 映射中，为对应 `id` 指定正确的 AniList 标题。
- **自动收录策略**：`fetch.mjs` 会抓取当季/上季/下季带 `Yuri` 标签的动画，但 AniList 的 Yuri 标签很宽泛，因此还要同时满足：Yuri 标签相关度 ≥ 40、无"男主/异性恋"高相关标签、且具备全女 cast 或女女恋爱信号（`isYuriAuto()`），个别误判可在 `AUTO_BLOCK_IDS` 中拉黑。
- **个人评分**：存放在浏览器 `localStorage`（key `yuri_my_ratings_v2`），不涉及后端。

## 📁 目录结构

```
yuri-recommender/
├── index.html              # 前端应用（含离线兜底数据）
├── data/
│   ├── curated.json        # 手工精编 185 部（唯一人工维护来源）
│   ├── anime.json          # 生成：富化 + 自动收录（应用实际读取）
│   └── meta.json           # 生成：更新时间 / 收录数 / 季度
├── scripts/
│   ├── fetch.mjs           # AniList 数据同步脚本
│   └── convert-legacy.mjs  # 从旧版单文件 HTML 抽取数据的迁移工具
├── .github/workflows/
│   ├── update-data.yml     # 每周定时同步数据
│   └── pages.yml           # GitHub Pages 部署
├── package.json
└── README.md
```

## 📜 数据与版权

- 番剧元数据、封面、社区均分与人气来自 **[AniList](https://anilist.co)**（GraphQL 公开 API，非商用）。
- 五维主观评分为本项目维护者个人观点，仅供参考。
- 封面图片版权归各自作权方所有，本项目仅作非商业索引展示。

## 📄 License

MIT License © 2026 花占卜项目组
