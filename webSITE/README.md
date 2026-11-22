# Rocktier

**Fast, private, rock-solid tools — as one family.**

Rocktier 是一套小而美的轻办公工具系列。每个工具只专注做好一件小事，快、注重隐私、坚若磐石。本仓库是 Rocktier 官方品牌官网。

Rocktier is a family of small, lightweight productivity tools. Each tool does one thing brilliantly — fast, private, and rock-solid. This repository contains the official Rocktier website.

## 打开 / Run

纯静态站点，零依赖，任何静态服务器或直接双击即可打开：

```bash
# 任意静态服务器
npx serve .
# 或直接打开
open index.html
```

Only static files — open `index.html` directly or serve the folder with any static server.

## 页面 / Pages

| 文件 | 说明 |
|------|------|
| `index.html` | 首页：Hero、产品矩阵、理念主张、CTA |
| `about.html` | 品牌故事：Rock · Tier 两个字一个理念 |
| `markdown.html` · `pdf-squeeze.html` · `cad-viewer.html` · `pic2webp.html` | 各产品页 |
| `download.html` | 下载汇总页 |
| `vs-online-tools.html` | 与在线工具的对比页（离线/隐私论据） |
| `license.html` · `privacy.html` · `terms.html` | 授权、隐私政策、服务条款 |
| `404.html` | 未找到页 |
| `css/styles.css` | 设计与主题令牌（深色/浅色、Nothing 单色风） |
| `js/main.js` | 双语切换 + 深浅主题 + 轻量动效 |
| `assets/` | Logo 与产品图标（family 品牌资产） |

## 特性 / Features

- **双语** / Bilingual — 中 / En 一键切换，自动跟随浏览器语言
- **深浅主题** / Light & dark — 单色反相，跟随系统或手动切换
- **轻量动效** / Light motion — 零依赖 CSS 动画 + IntersectionObserver 滚动浮现
- **快速** / Fast — 无外部资源、无框架、无网络字体
- **离线可用** / No internet needed — 本地即可完整体验

## 命名规范 / Naming

每个软件统一为 `Rocktier <功能词>`（如 `Rocktier PDF`、`Rocktier CAD Viewer`、`Rocktier pic2webp`）。完整品牌准则见家族台账（私有仓库 `rocktier-docs`）。

Every product is named `Rocktier <function>` (e.g. `Rocktier PDF`, `Rocktier CAD Viewer`, `Rocktier pic2webp`). Full brand guidelines live in the family records (private `rocktier-docs`).