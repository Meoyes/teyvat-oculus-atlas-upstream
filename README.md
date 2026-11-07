# 神瞳图鉴 · 上游仓库（仅发布公告）

> 本仓库**只发布公告**。站点的代码、地图瓦片、点位与攻略数据全部随
> **站点静态部署**发布，不再进入本仓库。

## 本仓库内容

| 路径 | 说明 |
| --- | --- |
| `manifest.json` | 轻量清单：`version` 与 `announce`（路径 / 字节数 / sha256）；`_sig` 内含正文与 Ed25519 签名，避免 CDN 缓存错配 |
| `manifest.json.sig` | 对整个 `manifest.json` 的 Ed25519 签名（旧客户端兼容用） |
| `data/announce.json` | 公告内容（来自站点 `site/data/announce.json`） |
| `README.md` | 本说明 |

`manifest.json` 里 `files` / `code` / `changelog` / `counts` 四个字段恒为空，
是给**尚未更新的旧客户端**的兼容垫片：`loadManifest()` 要求 `m.files` 存在，
`sanitize()` / `diff()` 会读取 `files` / `code` / `changelog`。旧客户端据此认为
「没有任何资源变更」，只拉取公告，不会误删或覆盖本地缓存。

## 更新日志

更新日志已迁移为站点静态文件 `site/data/changelog.json`，随静态部署发布。
新增条目请用：

```bash
python scripts/bump_changelog.py --note "本次更新说明" --tags 界面,点位
```

## 发布流程（站点项目根目录执行）

```bash
# 1. 生成 4 个产物（不联网、不推送）
python scripts/build_upstream.py

# 2. 提交并 force push（token 来自 GITHUB_TOKEN 或 server/.gh.token）
python scripts/build_upstream.py --publish
```

## 已废弃参数

为兼容旧调用，以下参数仍可传入，但**全部为 no-op**（不报错、不产生作用）：

`--note`、`--tags`、`--title`、`--no-changelog`、`--min-app`

它们原本用于生成上游更新日志 / 设置最低客户端版本；新架构下更新日志走
`bump_changelog.py`、代码版本走静态部署，这些信息都不再由上游仓库承载。

## 当前版本

- `version`: `2026.11.07.1`
- `date`: `2026-11-07T12:20:43+08:00`
- `announce.size`: `640` B
- `announce.sha256`: `46e8a6c59b5326115ea4652bab0b079680898693ab0dfded7a7516a53e0fc91c`
