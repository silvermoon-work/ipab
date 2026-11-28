# IPAB 操作参考

## Swarm 与内容定位

Swarm 是人与 Agents 共同的信息共享域，不是单个 Agent 的本机目录。
域内共享名称统一映射到内容；不同 Swarm 的同名路径可以指向不同内容。
本机别名只是选择 Swarm 的快捷方式，不是跨设备身份。

```sh
ipab --version
ipab swarm list
ipab swarm use work
ipab --swarm work search hello
ipab --json search hello --current
```

`search` 按名称关键字检索已登记 Swarm，不是全文搜索；`--current` 限定当前域。
`ipab://work/notes/hello` 使用本机别名，`ipab:///notes/hello` 使用显式 `--swarm`
或保存的默认 Swarm。跨设备传递引用时使用搜索返回的完整 URI，其 authority
编码稳定的配置 URL，不使用本机别名或旧 Swarm CID。

已有 Swarm 的设备接入通过 `swarm request` 和 Owner 的 `swarm approve` 完成；
不是 `join`。具体参数按需查看 `ipab swarm request --help`。
Swarm 选择同时决定共享名称和内容获取来源；独立 CID 和具名 pin 也可仅在本机使用。

## 检查与读取

```sh
ipab --json bundle inspect CONTENT_CID
ipab --json get ipab://work/notes/hello
ipab get ipab://work/notes/hello --output hello
ipab --swarm work get CONTENT_CID
ipab bundle import content.car
```

`get` 验证并解包完整 Bundle，不执行入口。不指定 `--output` 时创建独立临时
目录，普通 stdout 只输出绝对路径；指定输出时目录须为新目录或空目录。
临时目录在退出后保留，使用完毕由调用方清理；持久用途指定输出或复制。

JSON 结果的 `cid` 是实际内容，`targetCid` 是原始目标；若名称指向 Artifact，
两者可能不同。编辑迭代时保留 `targetCid`，不要用内容 CID 代替版本基线。
`get --raw` 获取 Artifact 本身，而不是其中的内容。

## 保存、共享与迭代

Bundle 包含 `.bundle.yaml`、其引用的纯类型文件，以及入口和资源。
manifest 的 `title`、`entry`、`type` 必填；`description` 可选。
类型文件声明 MIME `contentType` 和可选 JSON Schema。
类型 CID 标识契约，内容 CID 标识具体实例。Markdown Schema 校验 frontmatter，
正文和资源保留原内容。

```yaml
# .bundle.yaml
title: Shared note
description: A reusable work result
entry: note.md
type: .bundle-type.yaml
```

```yaml
# .bundle-type.yaml
contentType: text/markdown
```

创建 `note.md` 后构建；构建的 JSON 结果提供 CID 和 CAR 路径：

```sh
ipab --json bundle build ./note
ipab pin add my-note CONTENT_CID
ipab --swarm work publish CONTENT_CID --name notes/hello
ipab --swarm work publish NEXT_CONTENT_CID --name notes/hello --expect OLD_TARGET_CID
```

`pin` 是本机短名和保留，不等于 Swarm 共享发布。发布具名内容默认创建 Artifact；
名称须未占用，迭代须提供准确旧 Artifact CID。冲突后重新获取当前版本并处理差异，
不以新内容直接覆盖。`publish --snapshot` 可为普通内容创建初始名称，不提供
该 Artifact 迭代链。发布不构建内容；根 `ipab build` 是通用配方组装，不负责
应用编译。应用开发可从 `ipab init --help` 和 `ipab build --help` 开始。

## 使用 App 与 Skill

```sh
ipab exec APP_CID --help
ipab exec ipab://work/apps/reader CONTENT_CID
ipab register set TYPE_CID APP_CID
ipab open CONTENT_CID
```

`exec` 将 App 引用之后的参数原样传给 App。`open` 使用已保存的准确类型到
App 的关联，要求 App 声明支持该类型；不是自动选择应用。

标准 Skill Bundle 包含 `SKILL.md` 和它引用的资源。Bash 中可先导出再复制安装：

```bash
folder=$(ipab get builtin:skill.ipab) &&
  npx skills add "$folder" --global --agent github-copilot --copy
```

也可将引用替换为其他 Skill 的 CID 或共享名称。赋值和 `&&` 在获取失败时阻止
安装；引号保留路径空格，`--copy` 避免安装依赖临时目录。
IPAB 随 CLI 提供内置 Skill Bundle；安装到 Agent、发现及默认加载正文由 Agent
的安装与配置机制决定，不由 Bundle 的 frontmatter 保证。

管理和开发命令用 `--json` 获取结构化结果，检查退出码后再继续。
按需查看 `ipab --help` 和具体叶子命令的 `--help`。
