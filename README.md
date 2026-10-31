# 神瞳图鉴 · 上游资源仓库

`teyvat-oculus-atlas` 的增量更新上游。站点每次打开（间隔 ≥ 24 小时）会拉取本仓库的
`manifest.json`，按文件哈希对比出「新增 / 修改 / 删除」，只下载发生变化的文件，
并把已过时的文件从本地缓存中删除。

## 目录

| 路径 | 说明 |
| --- | --- |
| `manifest.json` | 版本清单：`version`、每组文件数与 `files{路径: [字节数, sha256前16位]}` |
| `changelog/changelog_YY_MM_DD.json` | 每日更新日志，同一天多次更新写入 `entries` 数组 |
| `data/` | 点位与地图数据（maps / markers_* / anchors / guide_*） |
| `tiles/` | 地图瓦片 |
| `assets/` | 图片与素材 |
| `code/` | **界面代码包**：`index.html`、`manifest.webmanifest`、`js/`、`css/` |

## 两条更新通道

| 通道 | 内容 | 客户端行为 |
| --- | --- | --- |
| `files` | 数据、瓦片、素材 | 写入 `gel-upstream-v1`，下次请求即生效 |
| `code` | `index.html` + `js/` + `css/` | 作为**整包快照**装进 `/__code__/<版本>/`，SW 按精确键供给，装完自动刷新一次 |

`code` 与 `files` 是**完全隔离的命名空间**，路径不会重叠。这一点是硬要求：
数据缓存按 `ignoreSearch` 命中，代码混进去就会出现「页面是新的、脚本是旧的」整站崩溃（2026-10-31 事故）。

代码包的三条安全线：

1. **原子**：`index.html` 与 `js/css` 来自同一个快照，不会错配；
2. **可回退**：本地保留上一版，新包启动失败会自动切回，并把该版本标记为 `blocked` 不再重试；
3. **部署优先**：站点重新部署（`sw.js` 变更）时清空代码包，已部署的版本立即成为权威。

`sw.js` 不在代码包内 —— Service Worker 脚本只能由浏览器直接向站点更新，放进缓存没有意义。

## 当前版本

- `version`: `2026.10.31.6`
- 文件数：`1723`
- 分组：`{"data": 12, "tiles": 1080, "assets": 631}`
- 代码包：`9` 个文件

## 发布流程（在站点项目根目录执行）

```bash
# 1. 同步资源并生成清单 + 当日更新日志
python scripts/build_upstream.py --note "本次更新说明" --tags 点位,地图

# 2. 提交并推送（需要 GITHUB_TOKEN 环境变量）
python scripts/build_upstream.py --publish
```

客户端更新入口：`site/js/upstream.js`（检查间隔、缓存名、镜像地址均在文件头部配置）。
