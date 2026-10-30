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
| `js/` `css/` | 界面与功能脚本（更新后需刷新页面） |

## 当前版本

- `version`: `2026.10.30.3`
- 文件数：`1125`
- 分组：`{"data": 11, "tiles": 1080, "assets": 27, "app": 7}`

## 发布流程（在站点项目根目录执行）

```bash
# 1. 同步资源并生成清单 + 当日更新日志
python scripts/build_upstream.py --note "本次更新说明" --tags 点位,地图

# 2. 提交并推送（需要 GITHUB_TOKEN 环境变量）
python scripts/build_upstream.py --publish
```

客户端更新入口：`site/js/upstream.js`（检查间隔、缓存名、镜像地址均在文件头部配置）。
