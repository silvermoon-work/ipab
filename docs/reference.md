# 命令与应用开发参考

本文收录 IPAB 的命令细节、应用开发、Bundle 协议及迁移说明。
首次使用请先阅读 [README](../README.md)；
参与 IPAB 本身的开发请阅读 [贡献指南](../CONTRIBUTING.md)。

**MVP 有意迁移：** 根 `ipab build` 已改为通用 `ipab.build.yaml` 配方组装；
旧 App 编译／prebuild／源码生成由显式项目工具完成，不再是 CLI build 行为。
新增 swarm/publish/get、共享 Name/Artifact 解析和完整迁移说明见
[MVP 实现与决策](mvp-implementation.md)。下文旧 App 构建章节保留为
`@ipab/cli/devtools` 项目工具的配置背景，不可把旧命令直接当作新 root
build 使用。

IPAB 以普通 Node 子进程执行 App Bundle，保留应用的 argv 与 stdin/stdout/stderr，
通过独立 IPC 提供 IPFS 文件流及可写输出 Space。**它不是沙箱**：应用拥有
当前用户的 Node、文件系统、网络和环境权限；只执行你信任的应用。
根 workspace 保持 private；五个 npm 包首轮准备
`0.1.0-rc.1`（`0.1.0-rc.0` 已发布），不包含节点管理流程。

## 使用

```sh
pnpm build
node apps/cli/dist/main.js --help
```

以下示例的 `ipab` 指构建后的 `apps/cli/dist/main.js`（也可用 Node 直接运行）。
CID 占位符应替换为真实的 CID：

```sh
ipab pin add reader <app-cid>
ipab exec reader --cid <content-cid>
ipab register set <schema-cid> reader -- --cid %
ipab open <content-cid>
ipab --json history list --status succeeded
ipab history remove --status failed --until 2026-11-01T00:00:00Z --yes
```

### 本机命令与上游 Gateway

CLI 包名为 `@ipab/cli`，命令为 `ipab`；当前准备 `0.1.0-rc.1`，尚未发布到 npm。
在仓库根目录构建并将本地包链接到全局（支持 macOS、Linux 和 Windows）：

```sh
pnpm link-cli
ipab --version
```

`link-cli` 先构建全部 workspace 依赖，成功后使用当前项目的 pnpm entry
执行本地全局链接，不发布 npm 包，也不切换 pnpm 版本。
链接后修改源码需重新 `pnpm build`，无需重新发布或安装包。
macOS／Linux 构建成功后自动为 CLI 入口添加执行权限，已有链接同样生效，
无需手动 `chmod`。
全局 bin 目录需在 PATH 中；未配置时先运行 `pnpm setup` 并重启终端。

可将局域网 Kubo 的 HTTP Gateway 或其他兼容 Gateway 配置为上游：

```powershell
ipab config set store.gateway http://127.0.0.1:8080
ipab config get store.gateway
```

这是只读 Gateway，不是 Kubo RPC API。IPAB 始终使用本地 Store；本地缺块才
从上游获取，校验后原子落盘。输出、pin、统计与 GC 不访问上游管理接口，
不上传 block、不启动 daemon。pin 完整获取 DAG 后可离线使用；
未 pin 的缓存经本地 GC 删除后，重新获取仍需要可用上游。
PowerShell 调用 `ipab` 时，argv 模板分隔符应写成引号包裹的 `'--'`，
避免 PowerShell 吞掉它：

```powershell
ipab register set <schema-cid> <app-cid> '--' '--cid' '%'
```

- 全局 `--state-dir PATH`、`--store-gateway URL`、`--json` 必须在子命令之前。
  `--json` 适用于管理／开发命令的结果元数据，不能包装 exec/open 的应用 stdout。
- `exec APP` 后的所有参数原样传入，包括 `--help`、`--json` 和 `--`。
  `exec --help` 是宿主帮助；`exec APP --help` 是应用参数。
  可用 `exec --log APP [APP_ARGS...]` 或 `open --log CONTENT` 按次记录
  stdout／stderr；exec 的宿主 `--log` 必须在 APP 之前。
- `open CONTENT`
  校验存储完整性、路径、完整类型定义和入口数据，从 `.bundle.yaml`
  计算准确类型 CID，使用保存的
  Schema → App + argv 关联。没有 `--app` 或临时模板覆盖，也不自动选择应用。
  启动子进程前还要求所选 App 的 supportedSchemas CAR roots 包含输入的准确
  类型 CID；省略声明意味着不支持任何 open 类型，不是通配符。关联本身不证明支持。
  不匹配须重建 App 并显式更新 pin/register，或使用普通 `exec`；不会成功回退。
  `register set` 省略模板保存 `["%"]`；显式模板必须包含整个参数 `%`，
  只替换整个参数，不展开 shell 字符串。其他资源与子 Bundle 不接受宿主的业务校验，
  引用格式、依赖读取与验证由 App 自行处理。
- `register set` 的 Schema 必须是 CIDv1/DAG-CBOR/SHA-256 block CID；
  也接受离线内置类型 alias
  `builtin:node-app.v1`，set/remove 都解析并保存准确 CID。
  不接受 UnixFS 目录 CID 或旧 builtin 注册键；builtin 不是 App 执行目标。
- 用户短名由具名 Bundle pin 提供；内置模板也以只读 built-in pin
  出现在 `pin list` 中，用户不能占用、删除或改名；其离线解析能力不变。
  `register list/set/remove` 保存解析后的准确 CID。改变已有关联需要
  `--replace`；
  相同值幂等成功。pin 改名／删除不影响关联或历史保存的准确 CID。
- 根及分组无参数显示帮助；所有节点支持 `-h/--help`。缺少叶子参数退出 2，
  不交互补参。管理操作成功 0、操作失败 1、语法失败 2；应用非零退出码保留。
- 帮助按命令分层：根及分组只提供导航，不展示示例；叶子命令只展示自身的参数、
  选项、示例和必要提醒。全局选项见 `ipab --help`，操作细节见
  `ipab COMMAND --help`（分组命令继续指定子命令）。

### 本地 Store 空间与 GC

```sh
ipab store usage
ipab --json store usage
ipab store gc
ipab --json store gc
```

人类可读输出使用十进制 KB／MB／GB 等单位（1 KB = 1,000 bytes），最多两位小数，
括号显示带千位逗号的精确 bytes；小于 1 KB 时直接显示 bytes。
GC 回收空间沿用相同格式，`--json` 保持数值型精确字节数。

`store usage` 返回 `{cachedBytes, pinnedBytes}`：前者为当前 Store 内所有
canonical CID block 文件的字节数，后者为所有持久递归 pin（含其他参与者的
pin）的完整 DAG block 字节并集。直接、间接子节点和跨根共享节点均按
CIDv1 去重；不计算 SQLite 元数据、暂存文件或文件系统分配开销。
内置 pin 内容在安装包内，只有实际进入当前 Store 并建立保留责任才计入。

`store gc` 返回 `{removedBlocks, reclaimedBytes}`，显式对整个当前本地
Store 做 mark-and-sweep，不仅清理当前 CLI 的内容。它不解除 pin、不删除历史，
保留全部参与者的 owner 引用、未完成保留操作和活跃导入的暂存 block。
完整验证所有受保护 DAG 后才开始删除；缺块、损坏、预算超限和协调失败均报错，
不通过 gateway 补块，也不以进程内缓存冒充磁盘数据。
中途取消或删除失败可能已有部分回收，失败不会返回成功结果，可再次执行。
不触碰未知文件或其他进程的临时文件，不自动触发清理。

与 Kubo 对齐的是仓库级递归 pin／显式 GC 行为，而非 `repo/stat` 的
RepoSize 统计口径。配置 Gateway 不改变本地统计／GC，不查询或回收上游仓库。
共享同一本地 dataDir 的参与者必须使用同一持久
coordinationDir；不同 registry 或不参与协调的外部写入者不受此锁保护。
未 pin／retain 的普通读写不获得 GC 保留责任；并发写入不承诺事务式统计快照，
GC 仅处理本轮开始时已枚举的 block。

### 具名 pin

用户具名 pin 同时承担内容保留责任和 `NAME → 准确 CID` 短名解析；不另设 Alias
与 pin 开关。名称以 ASCII 字母开头，后续允许字母、数字、`.`、`_`、`-`，
不能本身是 CID，不能占用 builtin 名字。不同名字允许指向同一 CID，各有独立
且不依赖可变名称的 Store owner。

内置 pin 的内容由 IPAB 安装提供，按相同 Bundle 协议计算并验证 CID；
无需联网或额外建立用户 Store owner，也不冒充 Kubo 的物理 pin。
它们始终只读，不能 `pin add/delete/rename`；安装升级可更新内置模板的准确 CID。
`pin list/show` 的 SOURCE 标明 `built-in (read-only)`，JSON 额外标记
`builtin: true`。
内置内容可直接用名字或准确 CID 供 Bundle 检查／模板初始化读取，
不需要先导入用户 Store：

| 内置 pin                   | 类型名                | 内容                    |
| -------------------------- | --------------------- | ----------------------- |
| `builtin:template.node`    | IPAB Project Template | 默认 Node 项目模板      |
| `builtin:template.web-app` | IPAB Project Template | 前后端 Web App 项目模板 |

内置 App／Template 类型 block 仍是离线类型定义来源，但不是 pin，
不会出现在 `pin list/show` 或 `resolvePin` 中。

```sh
ipab build
ipab pin add reader <构建返回的CID>
ipab exec reader
ipab pin list
ipab pin show reader
ipab pin rename reader my-reader
ipab exec my-reader
ipab pin delete my-reader
ipab pin show builtin:template.web-app
ipab init dashboard --template builtin:template.web-app
```

- `pin add NAME CID` 要求未占用名字和准确 CID，不支持覆盖、replace 或名称链。
  CID 必须指向完整 Bundle，先校验定义、入口及完整 DAG，再建立持久保留。
  裸文件、无定义的目录、单独类型 block 或普通 DAG-CBOR 均拒绝；
  图片等非结构化文件需与 `.bundle.yaml` 一起包装为 Bundle。
  owner／retain／confirm 协调仅作用于本地。没有可获取内容的来源、缺块、损坏、类型
  校验或存储失败均非零，不凭空登记为成功。
- `pin delete NAME` 释放该记录在**原后端**的保留责任并删除名字；不存在则失败。
  不删除共享 block、不卸载、不请求 GC、不保证立即释放磁盘；不影响其他名字、
  运行、历史或外部参与者的保留。后续改变 Store 配置不改变旧记录的释放目标。
- `pin rename OLD_NAME NEW_NAME` 原子地修改名字；冲突失败，不覆盖。CID、类型
  元数据、owner、register 和历史不变，不重新获取，也不执行 unpin → pin。
- `pin list [--type TYPE]` 只列 IPAB 管理的可用 Bundle pin，
  不冒充上游节点的 pin 清单。`pin show NAME` 显示完整名字、CID、
  非空类型名和准确类型 CID；`--kind` 已移除。
- `--type` 接受准确类型 CID或可用 Bundle pin 的名称，名称解析为该 Bundle 的
  类型 CID，不是其内容 CID；可使用内置模板 pin。
  不以可能重复的类型名称作为身份，不使用 `app.json` 的应用名称代替类型名。
  例如 `ipab pin list --type reader` 或
  `ipab pin list --type builtin:template.node`。
- 类型识别复用 Bundle 校验，类型名来自完整定义的 `name`，不是 App 显示名；
  不 catch 校验失败并降级为普通内容。存储完整性通过不表示未知 MIME
  的入口业务校验已执行，具体能力仍遵循 Bundle 的校验报告。
  add 保存校验得到的类型元数据；list/show 只读用户登记与内置内容，不隐式联网或宣称刚
  在线验证了节点状态。
- SQLite 在 Store 操作前原子预留名称、稳定 owner、原后端与恢复记录；
  retain 后提交引用和类型信息，confirm 与 Store 关闭成功后才登记为可用。
  删除先持久化 releasing 意图，Store 恢复／释放成功后再删除登记。
  中断或失败留下 `pending`／`deleting`，不能解析、改名或冒充成功；
  list 的 JSON 将其单独放在 `pending`，stderr 给出重试提示。
  重试相同 `pin add NAME CID` 或 `pin delete NAME` 使用原 owner／后端；
  活跃并发操作明确拒绝，执行／历史的临时 owner 清理不会释放具名 pin。

pin 不意味着执行、安装依赖或信任 App；IPAB 不启动／配置 daemon、不自动换后端。
`--json pin list` 返回 `items`、`pending`、`invalid`；成功项包含完整
`name`、`cid`、`kind: "bundle"`、非空 `typeName` 和准确 `schemaCid`；
内置项另有 `builtin: true`，用户项保持原字段形状。

旧版本的非 Bundle pin 不自动删除、转换或解除保留，list 将其单列为
`invalid: [{ name, cid, kind, reason }]` 并在 stderr 提示清理。
它们不能解析、show、rename 或作为 `--type` 来源；只能显式 `pin delete NAME`
释放该 owner 的原保留，再将内容包装为 Bundle 并建立新 pin。
查询和执行／历史恢复都不改变旧记录或保留责任。

旧 Alias 功能和数据兼容已彻底移除。打开状态库时删除旧 `aliases` 表，
不解析、展示或迁移其内容，JSON 不再返回 `legacyAliases`。
具名 pin、register 和历史不受影响；builtin 快捷名继续离线使用。

## App 开发（上层 Node profile）

Node App 的 `ipab.resolvePin(name)` 提供只读宿主具名 pin 查询（名称最多 256
字符）：ready 用户／内置 Bundle pin 返回准确 CID，不存在返回 undefined；
旧非 Bundle
pin、pending/deleting、损坏状态及 IPC 错误明确拒绝。它不读取旧 Alias、不联网、
不保留内容，也不改写 App argv。需要此能力的 App 应使用新版宿主。
Viewer 模板用它实现目录／具名 pin／CID 的单参数自动识别；目录仍优先，
同名 pin 只解析一次，不自动跟随重命名或内容变化。

根 `init` 通过通用 Template Bundle 创建任意项目或内容，默认使用 Node App 模板；
项目 `pnpm run build` 负责编译和打包；通用 `ipab build` 本身不编译。
使用已构建并链接到全局的本地 `ipab`（首轮 RC 尚未发布到 npm）：

```powershell
ipab init hello
Set-Location .\hello
# 先将 @ipab/cli 开发依赖链接到本机源码中的 apps/cli 目录
pnpm run build
ipab exec <app-cid>
# 修改后重新构建已有产物：
pnpm run build
# 只生成 CAR，不写 Store：
pnpm run build --no-import
# 已有 CAR 也可单独导入（不 pin）：
ipab bundle import .\dist\app.car
```

`init NAME [DIR]` 默认创建普通 private TypeScript npm package；内置 Node／Web
App
模板要求 NAME 为不带 scope 的小写 npm 包名，通用模板不施加 npm 包名规则。
省略 DIR 时创建 NAME 目录。目标必须不存在或为空，没有覆盖
源码的 force 选项。默认 Node 模板生成 `package.json`、严格
`tsconfig.json`、`src/main.ts`、
`ipab.yaml`、源码类型 `.bundle.yaml` 和 `.gitignore`；**不安装依赖**。脚本为普通
`tsc --noEmit` 与项目准备后调用通用打包器的 `build`，不声明不存在的 registry
`@ipab/cli` 版本。
项目声明准确稳定的 TypeScript `6.0.3` 和 `@types/node` `26.6.6`；
编译由本地 CLI 的 esbuild `0.28.2` 提供，不要求项目另装 bundler。

### 模板与扩展

`init NAME [DIR] --template TEMPLATE [--param KEY=VALUE]...` 选择数据模板，
不选择或执行 App：

```powershell
ipab init hello
ipab init my-web-app --template web-app
ipab init custom-app --template .\my-template
ipab init custom-app --template .\template.car --param description="My project"
ipab init custom-app --template my-template-pin --param enabled=true
```

模板是 **Content Bundle 数据**，不是可执行 App Bundle。`node` 是离线内置默认
Template Bundle；Node 与 Web App 模板在 CLI 构建时生成经过校验的 CAR，
随 CLI 包交付，运行时直接读取，不依赖仓库源码或安装 hooks。
本地合法 Bundle 目录、自足单根 CAR、准确内容 CID 和可用具名 pin
使用同一完整类型与渲染契约。只有 CID／pin 来源读取当前 Store；本地目录、CAR
及默认模板完全离线。init 从不执行 hooks、安装依赖、构建、运行 App 或自动 pin。
成功 JSON 的 `templateCid` 是所选模板的准确内容 CID，kind 为 `project-init`。
不返回生成内容的 `schemaCid`：通用模板的输出不一定是 App 或 Bundle。
未固化目录由同一确定性 Builder 计算身份，不写 CAR 或 Store。

专用完整 `.bundle.yaml` 定义由 `template-definition.ts` 的 `templateSchema`
唯一确定，入口固定为 `template.yaml`（YAML）。其准确类型 CID 为
`bafyreihydmyx5qvemxlidzyc7yflwxnidllorpaq7xoxlh264ozjnalqra`；
离线类型快捷名为 `builtin:project-template.v1`，不是可执行 App／模板内容选择器。
创建模板时复制完整模板类型定义，自行编写 `template.yaml` 与 `project/` 数据树。
类型定义不包含默认入口，不能从 Schema 自动生成项目：

```powershell
# 以仓库 Node 模板为起点；安装后的 CLI 不依赖这些源码目录：
Copy-Item -Recurse .\templates\node .\my-template
# 修改 template.yaml 和 project 下的模板文件，再构建／导入（不执行模板）：
ipab bundle build .\my-template --no-import
ipab init demo --template .\my-template\dist\bundle.car
```

`template.yaml` 完整 v1 结构如下；不支持其他 root、suffix 或 render 选项：

```yaml
version: 1
root: project
render:
  suffix: .liquid
parameters:
  name:
    type: string
    required: true
  description:
    type: string
    default: ""
  enabled:
    type: boolean
    default: false
```

`name` 必须是 required string，由 `init NAME` 提供且不能用 `--param name=...`
覆盖；`description` 必须声明 string 和空字符串默认值。可额外声明最多 64 个参数，
类型仅 `string`／`number`／`boolean`／`json`，允许 `required` 和 `default`；
未知、重复、缺少必填参数或错误类型均失败。字符串值原样接受，其他类型必须是合法
JSON（number 必须有限）；不接受函数、特殊原型键或深度超过 32 的 JSON。
参数输入总计最多 64 KiB；可选且无默认值的参数为 null。

`project/` 就是输出目录布局；不渲染文件名。`*.liquid` 使用真实 **LiquidJS**
渲染后去掉一个 `.liquid` 后缀，如 `project/package.json.liquid` →
`package.json`。文本不做 HTML 自动转义；生成 JSON 请显式使用
`{{ name | json }}`。
支持条件、循环、赋值、capture、case、comment、raw 等数据标签和固定文本／数值／
数组 filters；未知标签或 filter 失败，include/render/layout/tablerow、文件 IO、
date 及任意自定义 JavaScript filter 不支持。未带后缀的普通文件原字节复制，
包括二进制与 dotfiles；控制定义和入口不输出。
拒绝穿越、符号链接、Windows 保留名和不分大小写的文件／目录／后缀碰撞；
不输出 `.git`／`node_modules`／`dist` 路径。项目最多 256 个路径、深度 32，
单文件 1 MiB、输入与渲染输出总计 8 MiB。Liquid 每文件限制 10000 个渲染步骤、
1 MiB 分配与累计输出，以及 1 秒渲染时间；定期让出事件循环检查取消，
失败或取消不留下已创建项目文件。

模板源码分别位于 [templates/node](../templates/node) 和
[templates/web-app](../templates/web-app)。`web-app` 是真实 Liquid Template
Bundle，包含 Vite + 原生 TypeScript 前端、自包含 Node 后端和
`ipab.yaml`。`node`／`web-app` 是对应 built-in 模板 pin 的 Init 简写。
内置 pin、快捷名与目录／CAR／CID 使用相同校验及展开协议，
`templateCid` 报告准确内容身份。
内置 Web 模板默认引用 CLI 所安装 `@ipab/web-app` 的准确版本，本轮准备版本为
`0.1.0-rc.1`；该框架版本实际发布后，生成项目可直接从 registry 安装。
不再自动写入设备专用的绝对 `file:` 路径。本地开发或未发布时须显式使用
`--param webAppDependency=file:...`。目录／CAR／CID 分发必须明确提供
`webAppDependency` 参数，内置快捷名也允许覆盖该参数。

```powershell
ipab init dashboard --template web-app `
  --param 'webAppDependency=file:D:/Code/ipab/packages/web-app'
ipab bundle build .\templates\web-app --no-import
ipab init dashboard --template .\templates\web-app\dist\bundle.car `
  --param 'webAppDependency=file:D:/Code/ipab/packages/web-app'
```

模板 CAR 只包含模板数据和项目文件，不包含构建后的 Web App、框架依赖或自己的
`dist/` 输出。使用本地框架时先构建框架，再在生成项目内显式安装依赖。

旧显式本地目录中的 `ipab-template.json` v1 暂时兼容（不接受 `--param`）；
有 `.bundle.yaml` 时必须按新的 Bundle 契约验证，不能降级绕过校验。
旧源文件按明确清单复制：

```json
{
  "version": 1,
  "files": [
    { "source": "package.json", "target": "package.json", "render": true },
    { "source": "ipab.json", "target": "ipab.json" },
    { "source": "src/main.ts", "target": "src/main.ts" }
  ]
}
```

`render: true` 的文件必须是 UTF-8，可用 `{{name}}` 替换项目名；未知变量失败。
未启用 render 的文件按原始字节复制，可包含二进制资源。目标必须包含
`package.json` 和 `ipab.json`；拒绝穿越、符号链接、路径碰撞及
`node_modules`／`.git`／`dist` 路径。最多 256 个文件，单文件 1 MiB、总计 8 MiB。
清单本身不执行；只有用户之后显式构建才执行项目代码。

### 项目 `ipab-prebuild` 策略

默认 Node 项目仍由 IPAB 执行严格 tsc 和内建 esbuild，不运行 npm hooks。
需要自定义构建时，在 `ipab.yaml`（或旧 `ipab.json`）**显式**选择另一种互斥策略：

```json
{
  "entry": "app.cjs",
  "resources": ["web"],
  "build": {
    "strategy": "ipab-prebuild",
    "typecheck": [
      { "config": "tsconfig.server.json", "entry": "src/server/main.ts" },
      { "config": "tsconfig.web.json", "entry": "src/web/main.ts" }
    ]
  },
  "app": {}
}
```

```json
{
  "scripts": {
    "build": "node scripts/prepare.mjs && node node_modules/@ipab/cli/dist/main.js build dist/prepared-app --output dist/app.car --replace",
    "ipab-prebuild": "node scripts/ipab-prebuild.mjs"
  }
}
```

流程为项目 `pnpm run build` → 准备工具执行严格类型检查及指定的 `ipab-prebuild` →
`ipab build` 校验与组装 → 按选项导入 Store。
直接 `ipab build` 不执行项目脚本。
**这是执行可信项目代码的模式**，与默认只编译源码不同；脚本和工具插件不是沙箱。
IPAB 不加载 Vite／esbuild 配置、不安装工具，不通过是否存在脚本来猜测策略。
钩子可自由使用 Vite、esbuild 或其他工具；模板预置的 Vite 为 `8.3.8`。

IPAB 使用项目声明的准确 npm/pnpm `packageManager`；未声明时沿用启动
`npm run build`／`pnpm run build`／`exec` 的 npm/pnpm，
直接调用且没有包管理器上下文时使用 npm。
不支持的声明、版本不匹配或工具不存在明确失败，不自动安装或切换版本。
只执行已安装包管理器自身的 CLI，不执行可能联网查询或下载版本的 Corepack shim；
若 PATH 中只有 shim，请通过已配置的 `pnpm exec ipab build` 传入实际 CLI。
通过 npm 执行时使用 `--ignore-scripts`，通过 pnpm 执行时关闭
`enable-pre-post-scripts` 和 `manage-package-manager-versions`；
只执行指定脚本，不隐式运行其前后置生命周期 hooks，也不让 pnpm 自动下载版本。
直接调用无法定位 pnpm CLI 时，可用已配置的 `pnpm exec ipab build`。
钩子 stdout/stderr 均作为诊断进入宿主 stderr，不污染 `--json` 输出。

钩子通过环境变量 `IPAB_BUILD_DIR` 获得本次全新绝对输出目录：

```text
IPAB_BUILD_DIR/
  app.cjs
  web/
    index.html
    assets/...
```

此模式的 `entry`／`resources` 相对此目录，而非源码目录；resources 可明确选取
文件或目录，目录按安全文件树递归收集。Node 程序原始字节保留为
`resources/app.cjs`，资源进入 `resources/<选取路径>`。不重复编译钩子程序；
esbuild 只静态分析其自包含性，拒绝动态加载、外部 npm 依赖和额外本地模块。
入口必须是有效 UTF-8 的 Node CommonJS 源码；IPAB 仅解析、不执行它，
不会将 ESM `import`／`export` 转换后再打包原文件。允许 CommonJS shebang；
无论配置的入口位于哪个子目录，Bundle 中唯一程序路径仍是 `resources/app.cjs`。
入口仍最多 8 MiB，资源单文件 16 MiB，路径总量最多 4096，并受 Bundle 总预算约束。
类型检查数组必须非空，每个配置执行项目本地严格 tsc，所选 TS／TSX 源入口必须实际参与检查；
后端和前端配置应分别声明 Node 与 DOM 环境，并包含共享代码及适用测试。

钩子失败、取消、缺产物或产物不合法均停止，不打包旧文件；已有 CAR 保持不变。
stdout／stderr 流失败或诊断接收器抛错同样失败，先停止自有钩子进程树，
等待进程关闭后才清理本次目录；跨数据块的 UTF-8 诊断字符不被拆坏。
`IPAB_BUILD_CHAIN` 用于同项目递归诊断，钩子不得清除标记或再次调用自身
`ipab build`。
取消仅终止本次钩子进程树；不清空源码、旧 dist 或共享 Store。
输出交接目录及 Bundle staging 均由本次构建拥有，结束后清理。

### Web App

模板同时支持 npm 和 pnpm；使用 pnpm 时可执行 `pnpm install`、
`pnpm typecheck`、`pnpm build`。生成的 `pnpm-workspace.yaml` 仅允许
esbuild 必需的安装脚本，不全局开放第三方生命周期脚本。

```powershell
ipab init my-web-app --template web-app
Set-Location .\my-web-app
npm install
npm run build -- --no-import
ipab bundle import .\dist\app.car
ipab exec <返回的App CID>
# 只打印 URL，不自动打开浏览器：
ipab exec <返回的App CID> --no-open
```

运行后默认用系统浏览器打开本机 URL，也始终向 stderr 报告该 URL。
`--no-open` 关闭框架的自动打开行为，适用于 SSH／无桌面环境；
打开失败明确报告并保留服务，可手动访问 URL。
前端 Vite 产物与 Node 后端在同一 App Bundle，
运行不需要 Vite dev server 或 node_modules。前端与后端分开构建、通过框架通信；
IPAB 仍只执行 Node 入口，不新增 Browser profile。框架不解释 Viewer／Task 业务。
框架 API、请求校验及页面生命周期见
[Web App framework](../packages/web-app/README.md)。

项目准备工具默认使用当前项目，
默认 Node 策略读取以下数据配置，不加载 JS 配置、npm lifecycle hooks 或用户插件；
显式 `ipab-prebuild` 策略则使用上面的可信项目编译契约：

```yaml
entry: src/main.ts
resources: []
supportedSchemas: []
build:
  includeSource: true
app:
  name: hello
  version: "0.0.0"
  description: ""
  # icon: resources/assets/icon.png
  # i18n:
  #   zh-CN:
  #     name: 你好应用
  #     description: 应用描述
```

脚手架注释展示 author/license 覆盖、icon 放置、name/description
i18n 与类型源文件。
可选功能默认关闭，不生成虚构 icon／Schema 或空目录占位文件。启用 icon 时创建
`assets/icon.png`，将 resources 的 `[]` 替换为 `[assets/icon.png]`，再取消 icon
行的注释。启用类型时创建完整定义 `schemas/note.json`，将 supportedSchemas
的 `[]` 替换为 `[schemas/note.json]`。已有 `ipab.json` 仍支持；迁移时转换为
`ipab.yaml` 并删除旧文件。只允许这两种配置且必须恰好存在一个，拒绝二者并存。
两种格式使用严格数据解析，拒绝重复键、未知字段／非法类型；注释和格式不参与
App 身份。不加载 JS 配置、不执行 hooks。

- 入口必须是 `src/` 下的 `.ts` 文件，并实际包含于项目 `tsconfig.json`。
  显式执行项目 `node_modules/typescript/bin/tsc`，强制严格检查与 noEmit，
  不允许 noCheck 跳过检查；缺依赖时失败并提示显式安装，不回退全局 tsc。
- 检查成功后 esbuild bundling=true/platform=node/format=cjs，生成唯一
  `resources/app.cjs`（最多 8 MiB），静态 npm 依赖纳入程序，只允许 Node
  builtins 外置；动态／间接 require/import、不兼容的 top-level
  await 等明确失败。
  程序不在构建时执行。
- resources 默认为空，只接受 `assets/` 下明确列出的非隐藏普通文件，
  无 glob、目录扫描或符号链接。资源在 App Bundle 内为
  `resources/assets/message.txt`。App 本体不打包源码、node_modules、配置、
  `.env` 或未选中的资源；可信 prebuild 的目录资源允许嵌套 Bundle 的
  `.bundle.yaml` 文件，其他隐藏文件与目录仍拒绝。应用通过自己的 App CID 和 Space
  context 读取资源，
  不依赖 materialized 程序旁的本地文件。
- supportedSchemas 默认为 `[]`，旧源配置省略也按空处理。只接受 `schemas/`
  下显式、唯一、非隐藏 `.json` 普通文件，无 glob、扫描、目录或符号链接。
  每个文件是**完整 Bundle 定义**（name、可选 description、entry 的
  必填 path/contentType、可选 schema），不是裸 JSON Schema；例如：

  ```json
  {
    "name": "Note",
    "entry": {
      "path": "note.json",
      "schema": { "type": "string" },
      "contentType": "application/json"
    }
  }
  ```

  严格解析并复用 Bundle
  runtime 校验完整类型定义、归一化和编码，按实际 CID 去重，
  roots 和 block records 按 CID 排序；改变源文件列表顺序不改变产物。
  非空列表生成单个 `resources/supported-schemas.car` 并自动写入 app.json
  supportedSchemas 路径；空列表不生成文件或字段。坏／缺源定义使整次构建失败，
  保留旧 CAR，仅清理本次自有数据。

- 每次使用全新唯一自有 staging，写入完整内置 `.bundle.yaml` 和默认 `app.json`，
  再复用 Bundle Builder 固化 CAR／CID。失败不打包旧程序或旧资源，
  只清理本次 staging，不清空 `dist`、旧 staging 或 Store。
- 默认 `dist/app.car`；沿用 `bundle.outputDir` 配置及其环境覆盖，
  但 App 输出必须在项目 `dist/` 内或项目外且扩展名为 `.car`，不得穿过符号链接。
  `--output` 相对当前工作目录解析。已有普通 CAR 需 `--replace`，
  类型检查／编译／资源失败保留原产物；不能用 replace 覆盖源码。
- `--json` 输出单个含 kind=`app-bundle`、cid、schemaCid、output、bytes 的结果，
  另有 imported 布尔值；启用源码时另含 source 对象，见下节。诊断／进度在 stderr。默认把 App
  CAR 的原始 block 写入
  当前 Store，**不 pin／retain**；`--no-import` 仅生成 CAR，不访问 Store。
  写入失败命令非零、保留已生成 CAR，可用 `bundle import FILE.car` 重试。
  没有自动执行、pin、watch 或另一个任务系统；未 pin 内容可能被外部 GC 回收。

### App CAR 中的源码

`build.includeSource` 默认为 `true`，默认 Node 与 `ipab-prebuild` 策略均适用。
项目工具的 `prepareApp(directory, { includeSource })` 调用可覆盖配置。
项目脚本执行准备和打包；通用 `ipab build` 不执行准备脚本。

```powershell
pnpm run build
ipab publish .\dist\app.car --name apps/hello
```

启用时生成独立 Content Bundle CAR：默认 `dist/app.source.car`，显式输出
`release.car` 时为同目录 `release.source.car`。源码完整类型定义放在项目根
`.bundle.yaml`；内置 Node/Web 模板生成 `IPAB App Source` 定义，以 `package.json`
为 JSON object 入口，其余项目文件为资源。已有项目未提供定义时，在源码快照中
使用此默认定义，不修改项目目录；已有定义必须正常通过通用 Bundle 校验，不降级。
根定义、入口及明确选择的构建输入被忽略时失败，提示修正规则或禁用源码包。

源码来自当前工作目录内容，包含未提交、未跟踪且未忽略的文件，不是 Git HEAD。
使用项目根及子目录的 `.gitignore`，支持目录剪枝、否定和子目录覆盖；
不依赖 Git 命令、仓库外祖先规则、`.git/info/exclude` 或机器全局配置。
不管忽略规则如何，都排除 `.git`、`node_modules`、根 `dist/`、活跃默认输出目录、
本次两个输出路径、根 `.ipab-app-*` staging 和 `.bundle-ignore` 控制文件。
源码选择不读取 `.bundle-ignore` 中的规则。符号链接和非普通文件拒绝；
字节、路径数量和深度受 Bundle 预算限制。**Gitignore 不是敏感信息扫描器**，
分发前须检查规则；模板默认忽略 `.env` 和 `.env.*`。

App 的 `app.json` 记录原源码 Bundle 的身份：

```json
{ "source": { "cid": "<源码 Content Bundle 的准确 CID>" } }
```

该字段由准备工具生成，不允许 `app` 元数据覆盖。新构建将这个 CID 对应的
UnixFS 子树挂在 `source/`，**不是**把 `.car` 文件嵌套成单个资源。
只导入或发布 App CAR 就包含源码 DAG；即使离线，也可 `ipab get <源码CID>`。
旧 App 若只有弱关联，仍需另行提供源码。关闭源码时不生成源码包、不挂入子树、不写关联；
不会删除以前生成的源码 CAR。

构建前冻结所选文件，构建后重新核对文件集合和字节，发现变化则失败，
不以构建后的源码冒充输入。编译／校验失败保留旧产物；两个 CAR 分别原子提交，
不是跨文件事务，最终 App 提交失败时已完成的独立源码 CAR 可能保留。
源码 CID 提供可校验的溯源，不保证可获取或任意环境下字节级复现：
锁文件、准确工具链、外部依赖及 hooks 的环境／网络输入仍需项目自行控制。
启用源码时，配置注释等原始字节的变化也会经由源码 CID 改变最终 App CID。

### App 元数据与内置类型

`app.json` 的 `name`、`version`、`entry` 必填；description 缺省为 `""`。
App 名称不为空白，版本使用准确 SemVer 2.0（支持 prerelease/build，不接受范围或
数字标识的多余前导零）。可选 author 为 `{name, email?}`，name 不为空白，
email 使用简单 `name@domain.tld` 检查；可选 license 是非空白声明文本，
**不控制读取、复制或执行，不提供 DRM**。
icon 是 Bundle 根相对的 `resources/` 普通文件路径，loader 验证安全路径和存在性，
不承诺 MIME／图像解码。默认 Node build 的 icon 必须引用已选中的
`resources/assets/` 文件；`ipab-prebuild` 可引用所选产物文件或目录中的资源文件。

可选 i18n 是由 Node Intl 接受的 BCP47 locale tag 到 `{name?, description?}`
的映射，拒绝无效或规范化重复的语言 tag、未知字段与非字符串翻译；
翻译名也不得为空白。语义为选中语言的字段分别覆盖 base name/description，
缺少翻译／字段回退 base，不实现语言选择 UI，也不隐式按前缀选择其他语言。
name／author
name／email／license／icon／version／supportedSchemas 路径的文本上限为 1024 字符。

构建从普通 `package.json`
的 name/version/description/author/license 复制元数据，
`ipab.yaml.app`（或旧 `ipab.json.app`）可覆盖这些字段并添加 icon/i18n；
不可覆盖生成的 entry、supportedSchemas 或 source。脚手架显式展示 name/version/description，
删除某个覆盖字段即可继承 package.json，描述未提供时为空。`.bundle.yaml`
的 name/description
命名共享 Node App 类型，不是单个 App；单个 App 元数据变化会改变内容根 CID，
不会改变共享类型 CID。

离线 alias `builtin:node-app.v1` 对应完整定义和 canonical DAG-CBOR CID：
`bafyreid3qonq3i2rjekgz7mtarpu4zbfmgg4uhtcjtpijdgrrhdke5opzq`。
alias 可用于 bundle inspect 与 register set/remove；状态只保存 CID。
这是有意的未发布协议迁移：旧 App 类型 CID 不再执行，app.json 的冗余
profile/runtime 字段仍被拒绝。本次移除 entry.defaultValue 改变了共享类型身份，
旧 App CID 不被静默接受；旧包应重建并显式更新 pin/register，不自动迁移。
Node 执行契约由完整类型 CID 唯一确定，不由 license 或 metadata 开关选择。

app.json 的可选 supportedSchemas 是安全的 `resources/` 普通文件路径，必须存在，
不可碰撞程序入口或控制文件；外部手工构建的 App 也须遵守。loader 在任何执行
（包括 exec）前验证此嵌套 CAR。它是非空、多根 Schema collection：每个 root
都必须为完整归一化 Bundle 定义的 CIDv1/DAG-CBOR/SHA-256，单 block 最多
1 MiB；必须含所有 roots，拒绝重复 roots／block records、额外 block、坏 hash、
非 canonical 定义或非法 Schema。复用现有文件数、字节、深度和聚合
work 预算，拒绝空的已声明 CAR。该声明不解析或改写 argv，exec 不做输入类型匹配。
嵌套 CAR 永不自动导入 Store、注册、pin 或 retain 其 roots；外层 App 保留的是
嵌套文件字节，不承诺其中 Schema blocks 可以全局按 CID 读取。
通用 Bundle Builder／import 对该资源保持不透明；register 仍是本地离线关联登记。

## Bundle 开发（底层）

目录根 `.bundle.yaml` 本身就是完整类型定义，包含必填 `name`、
缺省为空字符串的 `description` 和
`entry: { path, contentType, schema? }`。入口路径和 MIME 是固定契约，
`schema` 可选，采用标准 JSON Schema Draft 2020-12；缺省 `$schema` 即该版本，
显式声明仅接受 `https://json-schema.org/draft/2020-12/schema`。
Schema 字面值保留，不注入 `$schema`、不应用 `default` 或删除字段；
省略 schema 和显式 true 的类型身份不同。`entry.defaultValue` 已移除并被拒绝。
完整定义的 canonical DAG-CBOR CID 用于注册；
实际数据修改不改变类型 CID。

`contentType` 接受合法 MIME（含合法参数），不根据扩展名推测格式。
`application/json`、`application/yaml`、`application/jsonl` 和 `text/markdown`
提供结构化解码；其他 MIME 的入口只进行字节／完整性检查。
即使声明 schema，也只检查 Schema 本身，不声称已校验不支持解码的入口。
当前解析器忽略 MIME 大小写，但不剥离参数；带参数 MIME 合法，入口报告 unsupported。
省略 schema 不约束解码值；有 schema 时验证实际入口，不生成数据。
Markdown 的 `entry.schema` 只约束文件开头 YAML frontmatter
对象，不约束正文。准确 `---` 行包围 frontmatter，支持 LF／CRLF；
缺省或空 frontmatter 视为 `{}`，能否通过由 Schema 决定。
未闭合 frontmatter、重复键、非对象数据及非法 YAML 明确失败。
整个入口（包括正文）仍须符合 UTF-8 和字节预算，正文与链接不触发业务解析或读取。
正文和资源由作者或通用 Template Bundle 提供，不从 Schema 推导初始数据。
Schema meta 校验使用 Ajv2020，数据使用 TypeBox Check 解释器，不生成验证代码。
format 仅作 annotation；支持文档内指针／anchor 与嵌套 $id，不加载外部 Schema。
共享 work／depth 限制约束遍历与求值访问，不提供 ECMA regex 的硬 CPU／时间限制，
不是不可信 Schema 的沙箱。
完整语义见
[Bundle runtime](../packages/bundle/README.md)。

从仓库根体验以下离线闭环（`ipab` 也可以替换为
`node .\apps\cli\dist\main.js`）：

```powershell
ipab bundle build .\examples\note-type\.bundle.yaml --schema-only --no-import
Copy-Item -Recurse .\examples\note-type .\my-note
ipab bundle build .\my-note --no-import
ipab --json bundle inspect .\my-note\dist\bundle.car
```

- `bundle build SOURCE` 校验实际入口，产出默认 `dist/bundle.car`；
  `--schema-only` 只读取并校验完整类型定义，产出单 block `dist/schema.car`
  和准确类型 CID，不要求实际入口存在。SOURCE 此时也可为定义文件。
  两种构建默认把结果写入当前 Store、不 pin／retain；`--no-import` 关闭写入，
  保留纯离线构建。`--json` 的 imported 表示是否已写入；写入失败保留 CAR，
  命令非零且不输出成功结果，可通过 `bundle import FILE.car` 重试。
  JSON `validation` 为入口 `{status, contentType}`；`--schema-only` 为 null，
  不把类型定义有效误报为入口数据已验证。
- `bundle init` 已移除。使用根 `ipab init NAME [DIR] --template TEMPLATE`
  和通用 Template Bundle 创建内容，或手工编写完整定义与实际入口；
  类型 CID／类型 CAR 不是模板，不会自动生成数据。
- `bundle inspect SOURCE` 接受目录、定义文件、`.car` 或 CID；
  全部适用校验通过才报告成功。未固化目录的 JSON `cid` 为 `null`，
  不把它冒充已构建根。CAR 必须单根且自足，本地缺块不隐式联网补齐。
  JSON `validation` 分别报告 definition=`valid`、storage=`verified` 或
  `not-applicable`，以及 entry 的 `{status, contentType}`（独立类型为 null）。
  entry.status 为 `validated`、`schema-absent` 或 `unsupported`；
  后两者不表示数据已通过 Schema 校验。
- 本地初始化／检查及 `build --no-import` 不需要 Store。默认构建导入和 CID 读取
  复用已有 Store 配置；不自动启动 daemon、执行 App 或 pin。
- `bundle import FILE.car` 是显式的 CAR → Store 入口，接受 App／Content Bundle
  或类型 CAR。输入必须为普通 `.car` 文件、单根且自足；先验证全部 block 的
  SHA-256、完整 DAG 和 Bundle／类型定义，缺块不从 Store 或网络补齐，
  验证失败不写入 Store。始终导入当前本地 Store，无需安装 Kubo；
  上游 Gateway 不参与导入写入，不上传到上游。
  使用 Store put 保存原始 block 和准确 CID，不 pin／retain，重复导入安全；
  不保证外部 GC 后仍可用。
  不执行 App、不创建具名 pin／register／执行历史，也不执行 GC。失败停止后续
  写入，不删除共享 block 或已有保留，部分 block 可能已写入；存储／关闭失败不报告成功，
  可重试同一 CAR。`--json` 输出 kind=`bundle-import`、cid、schemaCid、
  source（输入绝对路径）、blocks（唯一 block 数）、bytes（CAR 文件字节数）
  和 validation（入口 `{status, contentType}`，独立类型为 null）；
  人类输出给出根 CID，诊断／进度进入 stderr。
- `--output FILE`／`-o FILE` 覆盖具体产物位置，相对当前目录；
  `--replace` 仅授权原子替换普通产物文件，不能覆盖定义或入口。没有二进制
  stdout／stdin 模式；`--json` 输出单个结果对象，诊断与进度进入 stderr。
- 默认输出目录是源目录的 `dist`，可通过 `bundle.outputDir` 或
  `IPAB_BUNDLE_OUTPUT_DIR` 设置共同目录；相对配置在构建时相对源目录解析。
  不自动重写项目忽略规则。
- 根 `.bundle-ignore` 使用 gitignore 风格规则，初始化写入 `/dist/`，
  不默认忽略所有 CAR。控制文件本身不打包；忽略定义或实际入口明确失败。
  活跃默认输出目录（位于源目录内时）及本次输出文件不进入本次构建，
  因此无 ignore 文件时重复默认构建也不会把自己的产物带入。
- 构建先完整校验／消费输入，再提交完整 CAR；失败／取消清理本次临时文件，
  不清空源目录、`dist` 或共享 Store。再次构建已有产物需显式 `--replace`。

### Agent Skill Bundle

[示例目录](../examples/agent-skill)提供可复用的完整
[类型定义](../examples/agent-skill/.bundle.yaml)，固定入口为 `SKILL.md`、
`contentType: text/markdown`，遵循
[Agent Skills 字段规范](https://agentskills.io/specification)：

- 必填 `name`、`description`，均为字符串。name 长度 1–64，
  仅 ASCII 小写字母、数字与单个连字符，不能以连字符开头／结尾；
  description 长度 1–1024。
- 可选 `license`、`compatibility`、`allowed-tools`，均为字符串；
  compatibility 提供时长度为 1–500。
- 可选 `metadata`，为字符串值映射。
- 拒绝未知 frontmatter 字段；自定义元数据放在 `metadata` 中。

示例以标准 minLength／maxLength／pattern 校验上述字段约束，
不声称完成 Agent Skills 的全部语义校验：解包目录名与 skill name
一致性及描述质量等由消费端另行检查。正文是 Skill 指令，资源仍为不透明文件。
`allowed-tools` 是声明，不授予权限；构建／初始化／导入／校验不执行 Skill
或脚本，也不安装依赖、自动读取引用、注册 builtin 或加载到 Agent。
Skill 的发现、渐进加载和执行仍由 Agent 适配层负责。

从仓库根构建及检查示例：

```powershell
ipab bundle build .\examples\agent-skill --no-import
ipab --json bundle inspect .\examples\agent-skill\dist\bundle.car
ipab bundle build .\examples\agent-skill\.bundle.yaml --schema-only --no-import
```

类型 CAR 可以单独共享，但不是生成数据的模板。复制示例或通过通用 Template
Bundle 生成实际 SKILL.md，自行补充指令和可选
`scripts/`、`references/`、`assets/`。
复用类型时保持完整定义不变，只修改实际
`SKILL.md` 的元数据、正文和资源。
当前 Bundle 仍要求完整 `entry`；无入口资源类型尚未引入。

## Store、配置与结果

读写及保留使用本地 `@ipab/ipfs-store`；Content Bundle
校验使用本地 `@ipab/bundle`，均通过 `workspace:*` 依赖并按顺序构建。
两包的源码、测试和 MIT 许可证已迁入，尚未在新 scope 发布；
原发布包和源仓库不受影响。Store 的 ipfs-access/ipfs-payload 基础包仍使用
`@silvermoon-work` 发布依赖，不将它们冒充已迁移成员。
默认通过 Store 的 `/node` 配置 helper 读取 `TASK_CONTENT_CONFIG`／平台
TaskContent 配置，缺省使用 `~/.silvermoon.work/content` 的本地可写 Store。
不是虚构的默认 RPC 服务，也不是只读 gateway。

`store.gateway` 缺省为 `null`，表示沿用上述公共配置的可选 Gateway。
显式 HTTP(S) URL（`--store-gateway`／`IPAB_STORE_GATEWAY`／用户配置）
仅覆盖只读上游，不改变本地 dataDir、limits 或 coordinationDir。
URL 禁止凭据、查询和 fragment。默认 Store 配置中的 URL 同样检查。
连接或配置失败不会静默换来源。

Store RPC 已移除。`--store-rpc`／`IPAB_STORE_RPC` 明确报错；
旧用户键需执行 `ipab config reset store.rpc` 移除，再设置 store.gateway。
公共配置中的 backend:kubo／apiUrl／timeoutMs 不再支持，须显式替换成
backend:local、dataDir 和可选 gateway，不能将旧 Kubo coordinationDir
直接当作本地保留目录。旧 pin／历史记录保留原配置，既不自动迁移也不解除
daemon pin，相关恢复／删除明确失败且保留元数据。请用新名称重新建立
本地 pin，再独立管理旧 daemon 上的 pin；没有自动全量迁移命令。

| 配置键             | 默认      | 值域／环境变量                                                           |
| ------------------ | --------- | ------------------------------------------------------------------------ |
| `store.gateway`    | `null`    | 公共 HTTP(S) Gateway URL 或 `default`；`IPAB_STORE_GATEWAY`              |
| `history.enabled`  | `true`    | `true/false`；`IPAB_HISTORY_ENABLED`                                     |
| `history.limit`    | `20`      | 正的安全整数；`IPAB_HISTORY_LIMIT`，只用于查询，不清理记录               |
| `output.retention` | `history` | `history/none`；`IPAB_OUTPUT_RETENTION`                                  |
| `bundle.outputDir` | `dist`    | 非空目录路径；`IPAB_BUNDLE_OUTPUT_DIR`                                   |
| `pointers.service` | `null`    | HTTPS 服务 origin；仅本地开发允许 HTTP loopback；`IPAB_POINTERS_SERVICE` |
| `pointers.apiKey`  | `null`    | 32 字节随机 key 的无填充 base64url 编码；`IPAB_POINTERS_API_KEY`         |

`config get [KEY]` 显示有效值与 flag/env/user/default 来源；
`config set KEY VALUE` 只保存用户层，遇到更高优先级覆盖时提示；
`config reset KEY` 只移除单键用户覆盖，不清理历史或 pins。
坏配置明确报错。优先级为 flag > env > user > default。
状态目录由 `--state-dir`／`IPAB_STATE_DIR` 引导；默认 Windows
`%LOCALAPPDATA%\ipab`，其他平台 `$XDG_DATA_HOME/ipab` 或
`~/.local/share/ipab`，不存为自定位配置键。

Pointers API key 通过 `config set pointers.apiKey -` 从标准输入保存，
不接受秘密作为配置命令的 VALUE 参数。例如在 PowerShell 中：

```powershell
ipab config set pointers.service https://pointers.example.com
Get-Content -Raw .keys\api-key.txt | ipab config set pointers.apiKey -
```

配置查询与保存确认的文本和 JSON 均隐藏 key。
保存非空 key 时，将状态目录和已有 SQLite／WAL／SHM 文件限制为当前
OS 账号可访问；Unix 目录 `700`、文件 `600`，Windows 使用当前账号 SID 的
受保护 ACL。读取已存 key 时校验权限；这不是对所有既有状态目录的自动迁移。
服务 key 只用于创建 pointer，不进入 Swarm Bundle，也不赋予 owner/member 资格。
这些配置尚不代表完整 swarm 创建、授权与同步命令已接入；
服务运维工具使用显式参数、`IPAB_POINTERS_*` 环境变量或受保护的平面 JSON
cfg，不直接读取 IPAB 的 SQLite 配置。具体配置输入见
[pointer-worker](../packages/pointer-worker/README.md)，HTTP 契约见
[Pointers service API](pointers-service.md)。

成功执行（包括空输出）固化整个输出 UnixFS 目录根；输出不要求 `.bundle.yaml`
或 Schema。执行失败／取消或固化前发生错误时，不固化部分输出，记录
`outputCid: null`；
若输出已固化后才发生历史保存／清理错误，保留真实输出 CID，但整体仍失败。
应用退出 0 但输出提交／清理失败仍非零。输出 CID 及执行 ID 只提示到 stderr，
绝不追加到应用 stdout。详细 Node App profile 与流接口见
[设计概览](design-overview.md#node-app-profile-v1)。

## 历史与隐私

历史默认开启，保存 appCid、**实际 argv**、outputCid、起止时间、状态、
实际应用退出值或 null、错误阶段及记录自有保留信息；不设 contentCid，
默认不记录 stdio。参数可能有秘密：使用受保护的 stdin 或关闭历史，
不能依赖自动识别任意 App 参数中的秘密。

`history list` 与 `history remove` 共用 AND 筛选：`--app`、`--status`
（succeeded/failed/cancelled）、`--since`、`--until`。时间必须为明确时区
RFC3339，最多三位小数秒，按 endedAt 的 `[since,until)` 匹配；更高精度明确报错，
不截断边界。排序 endedAt DESC、ID DESC。
`list` 的 `--limit`／`--before RUN_ID` 只是分页；JSON 为 items/nextBefore，
下一游标是本页最后 ID。`show RUN_ID` 成功读取失败记录也退出 0。
这些查询不要求在线 Store。

`history list` 显示完整 RUN ID；翻页提示使用至少 8 字符的唯一前缀，
有冲突时自动加长，唯一性检查覆盖全部历史，不仅是当前页。`history show/remove` 和
`--before`
接受完整 ID 或至少 8 字符的唯一前缀，精确 ID 优先，歧义明确报错；
删除在确认前解析并固定完整目标 ID。持久 ID、JSON 和详情中的 ID 不变。
list 与 show 的 Started／Ended 使用类似 `git log --date=iso` 的本地时间格式：
`YYYY-MM-DD HH:mm:ss +0800`，包含对应日期的时区偏移，不显示毫秒或相对时间。
原始完整时间继续保存在 JSON 中，筛选和排序不变。

人类可读的 list 使用类似 git log 的逐条记录布局：首行显示完整 Run ID，
后续行以 Status、Started、Ended、Duration 标签显示状态、起止时间与耗时，
再显示完整 App CID、Output CID 和 argv，不截断。
Duration 为 endedAt -
startedAt 的经过整秒数，舍去不足一秒的部分，不表示 CPU 占用时间；
非法时间或结束早于开始时明确报错。JSON 字段保持不变。
匹配的可用 pin 短名只附加在 CID 后；多个 pin 时取按名称排序的第一个。
无输出显示 `none`；argv 使用 `join(' ')`，无参数显示为空，控制字符转义。
窄终端自然换行，不为保持一行压缩信息。
这是阅读用的展示，不保留参数边界，也不保证能直接交给 shell 重放。
`--json history list` 和 `history show` 保留完整 CID 和实际 argv；
显示 pin 名称不修改历史记录中的准确 CID。

`exec --log APP`／`open --log CONTENT` 要求历史开启，默认不开日志。
宿主将原始 stdout／stderr 分流至终端及状态目录
`logs/<完整 Execution ID>/stdout.log`、`stderr.log`；stdin 继续继承，永不记录。
不开日志时保留 stdio inherit；开启时 stdout／stderr 是 pipe，App 的 isTTY、
颜色和交互行为可能不同，不提供 PTY 或沙箱。
流式写入遵守背压，退出前排空输出；日志创建／写入／关闭失败明确报错且执行非零，
记录标记为 `incomplete`，成功记录为 `complete`，不承诺两个流的全局先后顺序。
show 展示现存日志的路径而不直接输出日志内容；记录日志的 JSON show 增加
`log` 状态和 `logs: { stdout, stderr }`，手工删除的文件对应路径为 `null`。
旧记录及未开启日志的记录兼容现有 JSON；list JSON 结构不变。
日志可能包含秘密且无自动容量限制，仅在需要调试时开启。
日志与历史共同管理：删除历史时删除对应两个日志文件及空目录；手工删掉日志
不影响历史。日志清理失败保留历史供重试，不递归删除未知文件、不执行 Store GC。

删除必须显式 ID 或筛选，两种方式互斥，无隐含全选，不支持分页选项；
删除全部匹配已结束记录，不限 20。确认之前固定目标集合；TTY 展示数量和保留
后果并确认，非 TTY 要求 `--yes`。部分失败明确报告已完成／剩余 ID。

`output.retention=history` 且历史开启时，每条记录以独立 durable Store owner
保留输出；先 retain，再提交记录，再 confirmRetained。删除只释放该记录的
责任；共享根及活跃执行由其他 owner 继续保护。原后端和协调配置保存在所有权
元数据中，改变当前配置不会在错误后端 unpin。释放失败保留可重试信息。
只回收确认 idle 的遗留 owner，不恢复活跃 owner。
`none` 或关闭历史时，运行结束后没有历史自有保留；CID 仍是实际已生成根，
但后端可能回收它。Local unpin 不删除 blocks；不执行 shared daemon GC。

## 设计概览

[IPAB Design Overview](design-overview.md) 汇总内容包、单 block DAG-CBOR
Schema、
入口类型契约、App Bundle、默认应用关联、快照及 Store 的设计方向，
并记录当前 Node profile、CLI、Space、输出保留与信任边界；
已确认 CLI 的普通 argv 语义取代早期“App 唯一输入 CID”假设。

## 协议参考

当前协议、标准 Draft 2020-12 Schema、引用边界和共享预算见
[Bundle runtime](../packages/bundle/README.md)，构建接口见
[Bundle builder](../packages/bundle-builder/README.md)。
完整 `.bundle.yaml` 定义直接编码为一个 DAG-CBOR block；编码后最多
1 MiB，超限不分块。入口 Schema 支持 `$defs` 与本地 JSON Pointer `$ref`，
不接受外部引用。`encodeSchema` 的输入是完整定义，不再是裸 JSON Schema。
CAR 携带准确类型 block；保留内容根即可从定义重建类型，无需读取外部 Schema。
旧 `entry.schemaCid` manifest 已移除；类型 CID 单独读取时仍须有对应 block。
旧 Schema Bundle 目录、descriptor、builtin 注册键和专用 Builder 已移除，
旧包须重建、更新 manifest 并按新 CID 重新注册，不提供自动迁移。
`x-content-ref` 扩展和递归内容依赖校验
也已移除；含该关键字的 Schema 必须更新，并按新 CID 重新注册。

工程命令、测试与交付要求见 [贡献指南](../CONTRIBUTING.md)。
