# dsh-plugins

DeepSeek Harness (DSH) 插件集合，同时作为自定义插件索引（Plugin Index）的托管仓库。

## 仓库结构

| 路径 | 说明 |
| --- | --- |
| `index.json` | 插件索引，DSH 的 Plugins → Discover 从这里读取 |
| `prompt-enhance/` | 输入框润色按钮：把草稿改写成更清晰的提示词 |
| `dsh-global-cmd/` | 全局命令面板：不依赖会话的常驻 CMD，可一键执行本机命令 |

## 索引地址

```
https://cdn.jsdelivr.net/gh/wrysmil/dsh-plugins@main/index.json
```

在 DSH 的 `plugin-market` 配置里加入该 URL，然后在 Plugins → Discover 中浏览安装。

## 索引格式

格式版本 `format: 1`，参考 DSH 的 `parseMarketIndex` 校验规则：

- 顶层必须有 `format: 1` 和 `title`（`title.en` 必填）
- `plugins[].name` 必须是合法 npm 包名
- `plugins[].versions[]` 非空，每项需要精确 SemVer 的 `version`、秒级整数 `publishTimestamp`、`source` 与 `engines.dsh`
- `source` 二选一：`{ "type": "npm" }` 或 `{ "type": "git", "url", "commit", "path" }`（commit 必须是 40 位小写 hex）

## 添加插件

1. 把插件目录放进本仓库
2. 提交并取到 40 位 commit SHA
3. 在 `index.json` 的 `plugins` 里加一条，`source.type` 用 `git`，`path` 指向子目录
4. push；jsDelivr 对 `@main` 有缓存，急用可以换 `@<commit>`

## 备注

- jsDelivr 要求仓库公开；索引抓取是匿名 GET，不能放需要鉴权的地方
- 索引 URL 不能带 query/fragment，且不能返回 302
