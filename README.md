# IPAB

InterPlanetary Application Bundle 的独立工程仓库。

IPAB 以普通 Node 子进程执行 App Bundle，保留应用的 argv 与 stdin/stdout/stderr，
通过独立 IPC 提供 IPFS 文件流及可写输出 Space。**它不是沙箱**：应用拥有
当前用户的 Node、文件系统、网络和环境权限；只执行你信任的应用。
当前 workspace 为 private，不包含 npm 发布或节点管理流程。

## 使用

```sh
pnpm build
node apps/ipab/dist/main.js --help
```

以下示例的 `ipab` 指构建后的 `apps/ipab/dist/main.js`（也可用 Node 直接运行）。
CID 占位符应替换为真实的 CID：

```sh
ipab alias set reader <app-cid>
ipab exec reader --cid <content-cid>
ipab register set <schema-cid> reader -- --cid %
ipab open <content-cid>
ipab --json history list --status succeeded
ipab history remove --status failed --until 2026-11-01T00:00:00Z --yes
```

### 本机命令与 Kubo

CLI 包名为 `@ipab/cli`，命令为 `ipab`；当前保持 private，尚未发布到 npm。
在仓库根目录使用 PowerShell 将构建后的本地包链接到全局：

```powershell
pnpm build
$pnpmEntry = pnpm exec node -p 'process.env.npm_execpath'
node $pnpmEntry add --global "@ipab/cli@link:$((Resolve-Path apps\ipab).Path)"
ipab --version
```

显式调用项目的 pnpm entry，避免全局操作切回本机其他 pnpm 版本。
链接后修改源码需重新 `pnpm build`，无需重新发布或安装包。
全局 bin 目录需在 PATH 中。

本地 Kubo daemon 已运行且 API 地址为 `127.0.0.1:5001` 时，可以保存配置：

```powershell
ipab config set store.rpc http://127.0.0.1:5001
ipab config get store.rpc
```

这是 Kubo RPC API，不是 gateway。IPAB 不启动 daemon；离线 daemon
只能读取已有内容。CLI 使用本地 workspace Store，已包含
`indirect through <CID>` pin 状态的兼容修复；配置成功不代替实际执行验证。
PowerShell 调用 `ipab` 时，argv 模板分隔符应写成引号包裹的 `'--'`，
避免 PowerShell 吞掉它：

```powershell
ipab register set <schema-cid> <app-cid> '--' '--cid' '%'
```

- 全局 `--state-dir PATH`、`--store-rpc URL`、`--json` 必须在子命令之前。
  `--json` 适用于管理／开发命令的结果元数据，不能包装 exec/open 的应用 stdout。
- `exec APP` 后的所有参数原样传入，包括 `--help`、`--json` 和 `--`。
  `exec --help` 是宿主帮助；`exec APP --help` 是应用参数。
- `open CONTENT`
  校验存储完整性、路径、完整类型定义和入口数据，从 `.bundle.yaml`
  计算准确类型 CID，使用保存的
  Schema → App + argv 关联。没有 `--app` 或临时模板覆盖，也不自动选择应用。
  `register set` 省略模板保存 `["%"]`；显式模板必须包含整个参数 `%`，
  只替换整个参数，不展开 shell 字符串。其他资源与子 Bundle 不接受宿主的业务校验，
  引用格式、依赖读取与验证由 App 自行处理。
- `register set` 的 Schema 必须是 CIDv1/DAG-CBOR/SHA-256 block CID；
  也接受离线内置类型 alias
  `builtin:node-app.v1`，set/remove 都解析并保存准确 CID。
  不接受 UnixFS 目录 CID 或旧 builtin 注册键；builtin 不是 App 执行目标。
- `alias list/set/remove` 只维护准确 CID 引用，不构成 alias 链，不 pin 或执行。
  `register list/set/remove` 保存解析后的准确 CID。改变已有目标需要
  `--replace`；
  相同值幂等成功。Alias 的后续修改不影响关联或历史。
- 根及分组无参数显示帮助；所有节点支持 `-h/--help`。缺少叶子参数退出 2，
  不交互补参。管理操作成功 0、操作失败 1、语法失败 2；应用非零退出码保留。

## App 开发（上层 Node profile）

根 `init`／`build` 面向 App；`bundle` 分组仍是不会编译代码的底层工具。
使用已构建并链接到全局的本地 `ipab`（CLI private，未发布到 npm）：

```powershell
ipab init hello
Set-Location .\hello
npm install
npm run typecheck
ipab --json build
# 修改后重新构建已有产物：
ipab build --replace
```

`init NAME [DIR]` 创建普通 private TypeScript npm package；NAME 为不带 scope
的小写 npm 包名，省略 DIR 时创建 NAME 目录。目标必须不存在或为空，没有覆盖
源码的 force 选项。生成 `package.json`、严格 `tsconfig.json`、`src/main.ts`、
`ipab.json` 和 `.gitignore`；**不安装依赖**。脚本为普通 `tsc --noEmit` 与
`ipab build`，不声明不存在的 registry `@ipab/cli` 版本。
项目声明准确稳定的 TypeScript `6.0.3` 和 `@types/node` `26.6.6`；
编译由本地 CLI 的 esbuild `0.28.2` 提供，不要求项目另装 bundler。

`build [DIR] [-o FILE | --output FILE] [--replace]` 默认使用当前项目，
读取数据配置（不加载 JS 配置、npm lifecycle hooks 或用户插件）：

```json
{
  "entry": "src/main.ts",
  "resources": ["assets/message.txt"],
  "app": {
    "name": "Hello App",
    "icon": "resources/assets/message.txt",
    "i18n": { "zh-CN": { "name": "你好应用" } }
  }
}
```

- 入口必须是 `src/` 下的 `.ts` 文件，并实际包含于项目 `tsconfig.json`。
  显式执行项目 `node_modules/typescript/bin/tsc`，强制严格检查与 noEmit，
  不允许 noCheck 跳过检查；缺依赖时失败并提示显式安装，不回退全局 tsc。
- 检查成功后 esbuild bundling=true/platform=node/format=cjs，生成唯一
  `resources/app.cjs`（最多 8 MiB），静态 npm 依赖纳入程序，只允许 Node
  builtins 外置；动态／间接 require/import、不兼容的 top-level
  await 等明确失败。
  程序不在构建时执行。
- resources 默认为空，只接受 `assets/` 下明确列出的非隐藏普通文件，
  无 glob、目录扫描或符号链接。资源在 Bundle 内为
  `resources/assets/message.txt`。不自动打包源码、node_modules、配置、
  `.env` 或未选中的资源；应用通过自己的 App CID 和 Space context 读取资源，
  不依赖 materialized 程序旁的本地文件。
- 每次使用全新唯一自有 staging，写入完整内置 `.bundle.yaml` 和默认 `app.json`，
  再复用 Bundle Builder 固化 CAR／CID。失败不打包旧程序或旧资源，
  只清理本次 staging，不清空 `dist`、旧 staging 或 Store。
- 默认 `dist/app.car`；沿用 `bundle.outputDir` 配置及其环境覆盖，
  但 App 输出必须在项目 `dist/` 内或项目外且扩展名为 `.car`，不得穿过符号链接。
  `--output` 相对当前工作目录解析。已有普通 CAR 需 `--replace`，
  类型检查／编译／资源失败保留原产物；不能用 replace 覆盖源码。
- `--json` 输出单个含 kind=`app-bundle`、cid、schemaCid、output、bytes 的结果，
  诊断／进度在 stderr。没有自动执行、导入、上传、pin、watch 或另一个任务系统。

### App 元数据与内置类型

`app.json` 的 `name`、`version`、`entry` 必填；description 缺省为 `""`。
App 名称不为空白，版本使用准确 SemVer 2.0（支持 prerelease/build，不接受范围或
数字标识的多余前导零）。可选 author 为 `{name, email?}`，name 不为空白，
email 使用简单 `name@domain.tld` 检查；可选 license 是非空白声明文本，
**不控制读取、复制或执行，不提供 DRM**。
icon 是 Bundle 根相对的 `resources/` 普通文件路径，loader 验证安全路径和存在性，
不承诺 MIME／图像解码。App build 的 icon 必须引用已选中的
`resources/assets/` 文件。

可选 i18n 是由 Node Intl 接受的 BCP47 locale tag 到 `{name?, description?}`
的映射，拒绝无效或规范化重复的语言 tag、未知字段与非字符串翻译；
翻译名也不得为空白。语义为选中语言的字段分别覆盖 base name/description，
缺少翻译／字段回退 base，不实现语言选择 UI，也不隐式按前缀选择其他语言。
name／author name／email／license／icon／version 的文本上限为 1024 字符。

构建从普通 `package.json`
的 name/version/description/author/license 复制元数据，
`ipab.json.app` 可覆盖这些字段并添加 icon/i18n；不可覆盖编译程序 entry。
生成的 config 默认 app={}，描述未提供时为空。`.bundle.yaml` 的 name/description
命名共享 Node App 类型，不是单个 App；单个 App 元数据变化会改变内容根 CID，
不会改变共享类型 CID。

离线 alias `builtin:node-app.v1` 对应完整定义和 canonical DAG-CBOR CID：
`bafyreigupykrgz6qvnm324bye4mu36rv7bhp2q5jzrn7zbkya54zay3qyq`。
alias 可用于 bundle init/inspect 与 register set/remove；状态只保存 CID。
这是有意的未发布协议迁移：旧 App 类型 CID 不再执行，app.json 的冗余
profile/runtime 字段现在被拒绝。旧包应重建并显式更新 alias/register，不自动迁移。
Node 执行契约由完整类型 CID 唯一确定，不由 license 或 metadata 开关选择。

## Bundle 开发（底层）

目录根 `.bundle.yaml` 本身就是完整类型定义，包含必填 `name`、
缺省为空字符串的 `description` 和
`entry: { path, schema, contentType, defaultValue }`。入口路径和格式是固定契约，
默认数据必须符合入口 Schema。完整定义的 canonical DAG-CBOR CID 用于注册；
实际数据修改不改变类型 CID。

从仓库根体验以下离线闭环（`ipab` 也可以替换为
`node .\apps\ipab\dist\main.js`）：

```powershell
ipab bundle build .\examples\note-type\.bundle.yaml --schema-only
ipab bundle init .\examples\note-type\dist\schema.car .\my-note
ipab bundle build .\my-note
ipab --json bundle inspect .\my-note\dist\bundle.car
```

- `bundle build SOURCE` 校验实际入口，产出默认 `dist/bundle.car`；
  `--schema-only` 只读取完整定义并校验默认值，产出单 block `dist/schema.car`
  和准确类型 CID，不要求实际入口存在。SOURCE 此时也可为定义文件。
- `bundle init TYPE DIR` 接受类型 CID、完整定义文件或 `.car` 类型产物，
  创建定义、默认数据和 `.bundle-ignore`。DIR 必须不存在或为空，不覆盖源码；
  这不保证 App 已具备可执行资源。
  `TYPE=builtin:node-app.v1` 是完整本地 Node App 定义的便捷解析，无需 Store：
  `ipab bundle init builtin:node-app.v1 .\raw-app`。它保留原始完整定义和准确
  App Schema CID，只生成描述／默认入口，不编译或生成可执行程序；
  register 可解析此 alias，但实际注册身份仍是 CID，不是 builtin 字符串。
- `bundle inspect SOURCE` 接受目录、定义文件、`.car` 或 CID；
  全部适用校验通过才报告成功。未固化目录的 JSON `cid` 为 `null`，
  不把它冒充已构建根。CAR 必须单根且自足，本地缺块不隐式联网补齐。
- 本地构建／初始化／检查不需要 Store。只有 CID 读取复用已有 Store 配置；
  不自动启动 daemon、执行 App、上传、导入或 pin。
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

## Store、配置与结果

读写及保留使用本地 `@ipab/ipfs-store`；Content Bundle
校验使用本地 `@ipab/bundle`，均通过 `workspace:*` 依赖并按顺序构建。
两包的源码、测试和 MIT 许可证已迁入，尚未在新 scope 发布；
原发布包和源仓库不受影响。Store 的 ipfs-access/ipfs-payload 基础包仍使用
`@silvermoon-work` 发布依赖，不将它们冒充已迁移成员。
默认通过 Store 的 `/node` 配置 helper 读取 `TASK_CONTENT_CONFIG`／平台
TaskContent 配置，缺省使用 `~/.silvermoon.work/content` 的本地可写 Store。
不是虚构的默认 RPC 服务，也不是只读 gateway。

`store.rpc` 缺省为 `null`，表示使用上述真实 Store 配置。显式 HTTP(S) URL
（`--store-rpc`／`IPAB_STORE_RPC`／用户配置）选择库的 Kubo backend，
替代整个公共 Store 配置；IPAB 不实现 Kubo HTTP 或另造通用 Store RPC 协议。
URL 禁止凭据、查询和 fragment。默认 Store 配置中的 URL 同样检查。
连接或配置失败不会静默换后端。

| 配置键             | 默认      | 值域／环境变量                                             |
| ------------------ | --------- | ---------------------------------------------------------- |
| `store.rpc`        | `null`    | 公共 HTTP(S) URL 或 `default`；`IPAB_STORE_RPC`            |
| `history.enabled`  | `true`    | `true/false`；`IPAB_HISTORY_ENABLED`                       |
| `history.limit`    | `20`      | 正的安全整数；`IPAB_HISTORY_LIMIT`，只用于查询，不清理记录 |
| `output.retention` | `history` | `history/none`；`IPAB_OUTPUT_RETENTION`                    |
| `bundle.outputDir` | `dist`    | 非空目录路径；`IPAB_BUNDLE_OUTPUT_DIR`                     |

`config get [KEY]` 显示有效值与 flag/env/user/default 来源；
`config set KEY VALUE` 只保存用户层，遇到更高优先级覆盖时提示；
`config reset KEY` 只移除单键用户覆盖，不清理历史或 pins。
坏配置明确报错。优先级为 flag > env > user > default。
状态目录由 `--state-dir`／`IPAB_STATE_DIR` 引导；默认 Windows
`%LOCALAPPDATA%\ipab`，其他平台 `$XDG_DATA_HOME/ipab` 或
`~/.local/share/ipab`，不存为自定位配置键。

成功执行（包括空输出）固化整个输出 UnixFS 目录根；输出不要求 `.bundle.yaml`
或 Schema。执行失败／取消或固化前发生错误时，不固化部分输出，记录
`outputCid: null`；
若输出已固化后才发生历史保存／清理错误，保留真实输出 CID，但整体仍失败。
应用退出 0 但输出提交／清理失败仍非零。输出 CID 及执行 ID 只提示到 stderr，
绝不追加到应用 stdout。详细 Node App profile 与流接口见
[设计概览](docs/design-overview.md#node-app-profile)。

## 历史与隐私

历史默认开启，保存 appCid、**实际 argv**、outputCid、起止时间、状态、
实际应用退出值或 null、错误阶段及记录自有保留信息；不设 contentCid，
不捕获 stdio。参数可能有秘密：使用受保护的 stdin 或关闭历史，
不能依赖自动识别任意 App 参数中的秘密。

`history list` 与 `history remove` 共用 AND 筛选：`--app`、`--status`
（succeeded/failed/cancelled）、`--since`、`--until`。时间必须为明确时区
RFC3339，最多三位小数秒，按 endedAt 的 `[since,until)` 匹配；更高精度明确报错，
不截断边界。排序 endedAt DESC、ID DESC。
`list` 的 `--limit`／`--before RUN_ID` 只是分页；JSON 为 items/nextBefore，
下一游标是本页最后 ID。`show RUN_ID` 成功读取失败记录也退出 0。
这些查询不要求在线 Store。

`history list` 的 RUN ID 显示至少 8 字符的唯一前缀；有冲突时自动加长，
唯一性检查覆盖全部历史，不仅是当前页。`history show/remove` 和 `--before`
接受完整 ID 或至少 8 字符的唯一前缀，精确 ID 优先，歧义明确报错；
删除在确认前解析并固定完整目标 ID。持久 ID、JSON 和详情中的 ID 不变。
ENDED 在不足一小时显示分钟（如 `10m`，不足一分钟为 `0m`），
不足一天显示小时（如 `5h`），满一天显示 UTC 日期（`YYYY-MM-DD`）；
未来时间也显示日期。完整时间继续保存在 JSON 和详情中，筛选和排序不变。

APP／OUTPUT 优先显示当前匹配的 alias；
多个 alias 时取按名称排序的第一个，没有 alias 则显示 CID 前缀。
两列最多 16 个字符，超限以 `...` 结尾。ARGV 按命令行样式以空格连接，
特殊参数使用 JSON 字符串引号／转义，空参数为 `""`，无参数为 `-`；
在终端中自动使用固定列以外的剩余宽度，超限以 `...` 结尾，
按实际显示列计算中文／emoji 宽度，不拆开组合字符。
重定向或无法读取终端宽度时，仍最多显示 48 个字符，不截断 Unicode 码点。
极窄终端无法容纳固定列时，保留 ARGV 标题的最小宽度，表格仍可能换行；
不会为此截断其他列。
这只是阅读用的摘要，不保证可以直接交给任意 shell 重放。
`--json history list` 和 `history show` 保留完整 CID 和实际 argv；
显示 alias 不修改历史记录中的准确 CID。

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

[IPAB Design Overview](docs/design-overview.md) 汇总内容包、单 block DAG-CBOR
Schema、
入口类型契约、App Bundle、默认应用关联、快照及 Store 的设计方向，
并记录当前 Node profile、CLI、Space、输出保留与信任边界；
已确认 CLI 的普通 argv 语义取代早期“App 唯一输入 CID”假设。

## 开发环境

- Node：使用 [.node-version](.node-version) 中的准确版本。
- pnpm：使用 [package.json](package.json) 中的准确 `packageManager`。
- 使用当前设备已配置的 registry；仓库不设置本机镜像或保存认证信息。

```sh
pnpm install
pnpm check
```

CI 使用 `pnpm install --frozen-lockfile`。开发 Node 与根包的兼容范围分开；
CI 默认 job 使用 `.node-version`，兼容矩阵沿用参考工程的
`22.15.0` / `24.11.1`。新增业务包时单独确认其运行环境承诺，
不把此脚手架的通过结果当作未来应用的兼容性证据。

Node 选择依据为 2026-11-23 搭建时读取的
[官方发布索引](https://nodejs.org/dist/index.json) 和
[官方支持计划](https://github.com/nodejs/Release/blob/main/schedule.json)：
最高稳定、标为 LTS 且仍受支持的版本为 `26.13.1`。
后续更新必须重新取得一小时内的新鲜证据。

## 结构

```text
apps/ipab/             @ipab/cli：private CLI、Node runtime、IPC context 与回归测试
packages/bundle/       @ipab/bundle：private 存储完整性、入口校验和 Schema
packages/bundle-builder/ @ipab/bundle-builder：repeatable VFS 与确定性 UnixFS/CAR
packages/ipfs-store/   @ipab/ipfs-store：private Local/Kubo Store 与保留协调
scripts/lib/           成员共享工具启动逻辑
docs/agent-project.md  项目工程指导
pnpm-workspace.yaml   workspace、catalog 和安装策略
turbo.json             依赖顺序与缓存
tsconfig.json          严格 TypeScript 基础配置
vitest.config.ts       各 code package 共用的测试与覆盖率配置
.github/workflows/ci.yaml
```

当前协议、结构化 Schema 方言、引用和共享预算见
[Bundle runtime](packages/bundle/README.md)，构建接口见
[Bundle builder](packages/bundle-builder/README.md)。
完整 `.bundle.yaml` 定义直接编码为一个 DAG-CBOR block；编码后最多
1 MiB，超限不分块。入口 Schema 支持 `$defs` 与本地 JSON Pointer `$ref`，
不接受外部引用。`encodeSchema` 的输入是完整定义，不再是裸 JSON Schema。
CAR 携带准确类型 block；保留内容根即可从定义重建类型，无需读取外部 Schema。
旧 `entry.schemaCid` manifest 已移除；类型 CID 单独读取时仍须有对应 block。
旧 Schema Bundle 目录、descriptor、builtin 注册键和专用 Builder 已移除，
旧包须重建、更新 manifest 并按新 CID 重新注册，不提供自动迁移。
`x-content-ref` 扩展和递归内容依赖校验
也已移除；含该关键字的 Schema 必须更新，并按新 CID 重新注册。

成员 build/typecheck/test/test-coverage 均执行真实代码与测试，包括本地 writable
Store、生成的 UnixFS DAG 和实际 Node 子进程。没有 npm 交付包，因此
lint-package 无交付任务，不将它称为已验证的发布能力。

## 工程命令

| 命令                 | 用途                                                  |
| -------------------- | ----------------------------------------------------- |
| `pnpm build`         | Turbo 按依赖顺序构建成员                              |
| `pnpm typecheck`     | 检查根配置及所有成员类型                              |
| `pnpm lint`          | 全仓库 lint，包括根配置、成员源码与测试               |
| `pnpm format-check`  | 只读格式检查                                          |
| `pnpm format`        | 有意修改格式时使用                                    |
| `pnpm test`          | 单轮成员测试，不开启覆盖率                            |
| `pnpm test-coverage` | 成员覆盖率及四项门槛检查                              |
| `pnpm lint-package`  | 构建并检查声明该命令的交付包                          |
| `pnpm check`         | 格式 → 构建 → 类型 → lint → 覆盖率 → 包检查，失败即停 |
| `pnpm clean`         | 清理根和直接成员的 dist、coverage、Turbo 输出         |

已有根脚本继续使用用户确认的直接工具命令；新增成员遵循
`node scripts/<same-name>.mjs`，共享实现放根 `scripts/lib/`，传播工具退出失败。
标准 [AGENTS.md](AGENTS.md) 的旧脚本接口约定与这一选择的差异，
明确记录在 [项目指导](docs/agent-project.md)，不声称标准接口检查已经通过。

覆盖率包含未测试的成员源码，branches/functions/lines/statements 均为 90%。
每个 code package 必须以自己的 root 运行共享 Vitest 配置，
配置复用不代表根目录存在多项目测试 runner。

## 后续迁入包

共享工具版本放入 catalog，内部依赖使用
`workspace:*`。成员分别声明 build、typecheck、test、test-coverage；
ESLint 和 Prettier 从根目录统一执行。

成员测试可直接使用标准工具：

```sh
pnpm --filter <package-name> exec vitest run --root . --config ../../vitest.config.ts
pnpm exec turbo run test --filter=<package-name>
```

直接选择成员不会自动构建依赖；依赖感知操作使用 Turbo。
只有明确登记为 npm 交付项的成员才添加 `lint-package: publint --strict`。
迁移前不修改已有包的名字、版本、发布归属或 Trusted Publisher。

更多要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
