# Project Guidelines

## Scope

本仓库是 IPAB（InterPlanetary Application Bundle）的独立工程 workspace。
当前 `apps/cli` 已实现确认的 CLI、Node 子进程 profile、独立 IPC Space context、
本地元数据及 Store owner 协调。普通 App argv/stdio 取代早期单 CID Task 输入；
关联管理叫 register，不是 apps；open 不提供临时应用覆盖。
Content Bundle 与 Store 已迁入 `packages/bundle` 和 `packages/ipfs-store`，
名称为 `@ipab/bundle` 与 `@ipab/ipfs-store`；CLI 和 Bundle 使用
`workspace:*` 引用 Store。`@ipab/bundle-builder` 同属 npm 交付项；
Schema 编码与校验仍在统一的 Bundle runtime，已移除专用 Schema Bundle Builder。
五个 code 成员显式登记 npm 交付，首轮统一准备 `0.1.0-rc.0`；`@ipab/web-app`
是本机浏览器桥接框架。
`@ipab/bundle-viewer` 为 private React 同构封装，通过 Web App 的显式
renderFrontend hook 渲染真实内容并 hydration；标准数据式模板位于
templates/bundle-viewer，当前通过目录／CAR／CID 选择，不新增内置快捷名。
一个共享 React component callback 负责视图，准确完整类型定义仍须声明；
不自动兼容旧 DOM renderer／browser Task，不迁移旧 aliases 或文件 watch CLI。
本地链接同构组件时，模板 Node prebuild 须将 react/react-dom alias 到生成项目
的同一实例，Vite 保持 resolve.dedupe；相同版本不等于同一 hooks runtime。
真实 pnpm 安装验证须实际运行构建 App，检查内容 SSR 与连接关闭，不只检查 CAR。
Store 的 ipfs-access/ipfs-payload 基础依赖仍使用原发布包，未迁入本仓库。
private `@ipab/check-spec` 迁入 okr-agent 的 MIT React 定义查看器；
`apps/check-viewer` 由 bundle-viewer 模板初始化，为独立 private App。
Check 类型入口 check.yaml，instructions 为正文或显式 {path} Markdown 引用；
其他文档保持内联。Node prepareData 完成参数 Schema／唯一性检查与有界资源加载，
SSR／hydration 共用展开数据；浏览器使用构建期生成的静态 AJV 形状校验器，
不启用 unsafe-eval。examples/check-spec 是显式转换示例，不自动迁移旧文档。
Bundle Viewer 新增显式 folder 与 contentCid 互斥本地输入；
模板／Check App 接受 --folder PATH，页面约每秒请求受限 revision/chunk 方法，
有界重读并复核 .bundle.yaml／entry／被引用资源，不导入 Store、不全目录扫描。
更新复用 React，错误隐藏旧视图并自动恢复；Check App 保留有效 checkpoint ID，
删除 ID 回总览。CID 模式一次加载不变；关闭停止连接／计时／读取。
Viewer 单参数 source 按现有目录／具名 pin／CID 顺序解析，--folder 保留消歧。
private `@ipab/check-sdk` 与显式 `templates/check` 提供新 IPAB Check 作者接口；
全局 JSON Schema/typed parse、单步或有序数组、同次前序 outputOf，不迁入旧
Task Protocol。STDIN 单 JSON 值最多 1 MiB；结果固定 result.json，当前步骤、
pass 与非空 problems:{code,context}，不自动发布成功 output 或输入。
可信 prebuild 从同一份定义生成现有 Check Spec 类型的 model，作为实际
resources/check/ UnixFS 子 Bundle 内嵌，resources/check-model.json 保存准确
CID；运行先复核 model 再检查，结果 check/ 直接链接原 DAG，不计算 Markdown
闭包。业务失败正常提交，异常／取消／无效输入不提交。仅嵌套资源文件末段
.bundle.yaml 可突破隐藏资源限制；其他隐藏文件／目录仍拒绝。
App context.resolvePin 为有界只读 IPC 查询，复用 State 用户／builtin ready
pins；
不存在返回 undefined，非 ready／坏状态抛错，不使用 legacy aliases、不改 argv，
不 fetch／pin／retain。源名称只解析一次；只有目录模式更新。
根 build 只生成 App/source
CAR，不导入 Store；App 源码快照排除自身 .turbo／coverage。
该 Node runtime 不是沙箱，不宣称隔离不可信程序。

## Engineering

- 使用根 `.node-version` 的准确开发 Node 和 `packageManager` 的准确 pnpm。
- workspace 为 `apps/*` 与 `packages/*`；共享依赖使用 catalog，内部依赖使用
  `workspace:*`。
- 根包 private，五个 code 成员是单包 npm 交付项，声明 deliverable.yaml 和
  真实 lint-package；验证执行实际业务源码／测试和全部 tarball 安装。
- 沿用参考工程的 Turbo 依赖顺序与缓存，根目录统一执行 ESLint/Prettier。
- .gitattributes 固定文本文件以 LF 检出，与 Prettier 一致；不依赖本机 core.autocrlf。
- TypeScript strict 与 type-aware lint 覆盖所有成员源码和测试。
- 根 typecheck 显式检查共享 TypeScript 配置；成员必须声明自己的 typecheck。
- Vitest 在每个 code package 的 cwd 中以
  `--root . --config ../../vitest.config.ts` 运行。
- 全部四项覆盖率门槛为 90%，包含未测试源码，失败必须传播。
- 提交前执行 `pnpm check`；局部验证使用成员命令或 Turbo filter。
- 日常 PR/main 使用 `pnpm check-ci`，保留关键真实行为但不生成部分覆盖率；
  只有重复编译的构建变体带 `release-e2e` tag。完整 `pnpm check` 不过滤测试，
  发布前 `pnpm check-release`
  再加入真实 pnpm 安装验证。门禁详情见 CONTRIBUTING.md。
- 当前设备的 registry 由设备配置决定，不在仓库中写镜像或凭据。
- 只在实际交付成员声明 `lint-package: publint --strict`，根通过 Turbo 调用。
- 不复制参考工程的业务包、历史生命周期记录、发布授权或个人配置。
- 新成员 minimum engines.node 为 22.15.0，所有适用成员保持同一 minimum；
  不自动提高消费者最低环境。
- 迁入包保留原 MIT LICENSE、CID／协议与存储协调标识。private workspace
  使用统一的开发最低环境，旧发布包的消费者最低环境不变。
- Store 的 node:test 测试已改用 Vitest 的 test/onTestFinished/afterAll 和
  fake timers，保留本地存储与 Gateway 业务断言。已移除 Kubo RPC 后端及其
  专用测试；不访问共享 daemon 管理接口。
- 新成员脚本按完整标准使用 `node scripts/<same-name>.mjs`，共享逻辑在
  根 `scripts/lib/`，工具失败必须传播；下面的既有差异仅适用于已有根脚本。
- 运行时／CLI 边界、准确 App Schema 和保留策略见 docs/design-overview.md
  与 docs/reference.md。日常运行只删除自身创建的运行文件，不清空共享 Store
  或请求 daemon GC。显式 store gc 仅对当前协调式本地 Store 回收未受保护
  block，保留全部参与者引用、pin、未完成操作和导入；不解除 pin、不自动
  GC。store usage 按 block 文件字节统计缓存及递归 pin 的 CIDv1 去重并集，
  不含元数据／暂存文件／文件系统开销；两项均拒绝源适配器。
  Store 始终本地，仅可选只读 HTTP Gateway；CLI store.gateway、
  --store-gateway、IPAB_STORE_GATEWAY 覆盖上游但不改变 dataDir／保留。
  Store RPC／backend:kubo 已移除，旧配置和旧保留记录不自动迁移或解除；
  仅 config reset store.rpc 保留移除旧配置的显式入口。
- 当前 Bundle 协议见 packages/bundle/README.md：.bundle.yaml 本身是完整类型定义，
  包含必填 name、缺省为空的 description，以及 entry 的必填 path/contentType
  与可选 schema。contentType 接受合法 MIME，entry.defaultValue 已移除并被拒绝；
  固定路径不得碰撞控制文件。schema 使用标准 JSON Schema Draft 2020-12，
  缺省 $schema 即该版本，不注入声明或改写 schema 字面值，不应用默认值或强制类型转换。
  省略 schema 与显式 true 的类型 CID 不同；非结构化 MIME 的 schema 仍检查合法性，
  但入口只查字节／完整性，报告 unsupported，不声称已验证数据。
  Ajv2020 检查 Draft meta schema，TypeBox Check 解释器验证数据，不生成代码。
  共享 charge/depth 不提供 ECMA regex 的硬 CPU／时间界限，不宣称 Schema 沙箱。
  `text/markdown` 入口只解析开头 `---` YAML frontmatter 对象并校验，
  缺省／空块为 `{}`，正文保留原字节，不解析链接；整个文件须有效 UTF-8
  且受入口字节预算约束。实际入口由作者或 Template
  Bundle 提供，不从 Schema 生成。
  examples/agent-skill 提供 SKILL.md 完整类型定义与资源示例，标准 minLength/
  maxLength/pattern 校验 ASCII 小写名称与长度，拒绝未知字段；目录匹配与描述质量等
  语义由消费端检查，不注册 builtin 或自动加载／执行 Skill。当前仍要求完整 entry。
  完整归一化定义编码为 CIDv1/DAG-CBOR/SHA-256 block，最多 1 MiB，不分块。
  $defs、本地 JSON Pointer／anchor 引用在 entry.schema 文档内封闭；
  不解析外部 Schema，不读取或执行扩展关键字，未知关键字仅作 annotation。
  Schema 只约束入口数据，不约束其他资源；不支持 x-content-ref 或递归内容
  依赖校验，业务依赖交给 App。全部资源仍须通过存储完整性与路径检查。
  Builder 固定 UnixFS/CAR 参数，直接从定义计算类型 block 并纳入内容 CAR；
  不 graft 目录、不读取外部 Schema，保留内容根即可再生类型 block。
  CLI bundle build/inspect 支持本地定义、单根 CAR 和 CID；bundle init 已移除；
  根 init 通过通用 Template Bundle 创建项目或内容。build --schema-only
  生成单 block 类型 CAR。两种构建共用 bundle.outputDir，默认根 dist；
  .bundle-ignore 使用 gitignore 风格且自身不打包，初始化写入 /dist/。
  本次输出与活跃默认输出目录不能成为输入，忽略定义/入口须失败；
  只清理自身临时文件，产物替换须 --replace，不覆盖源码或非普通文件。
- 根 init NAME [DIR] 使用通用 Template Bundle，默认 Node 模板创建普通
  private TypeScript npm package；仅内置 App／旧 App 模板要求 npm 包名；
  根 build [DIR] 默认严格执行项目本地 tsc、esbuild self-contained Node CJS、
  新建自有 staging、再调用内部通用 Bundle Builder 输出默认 dist/app.car。
  ipab.yaml 是注释式规范配置，旧 ipab.json 仅在 YAML 缺省时兼容，二者并存拒绝；
  严格数据解析拒绝重复键／未知字段／非法类型，默认模式不加载 JS 或执行 hooks。
  模板可用默认值并展示 icon 路径、name/description i18n、author/license 和
  supportedSchemas；可选示例仅注释，不创建虚构文件或空目录占位。
  配置声明 src/ 下的 .ts 入口、明确 assets/ 非隐藏资源文件和 app 元数据覆盖；
  入口必须被 tsconfig 实际检查。只允许 Node
  builtin 外置；默认模式不安装依赖或执行 npm
  hooks／JS 配置／App，显式 ipab-prebuild 的可信项目执行规则见下，不 pin。
  CLI 默认将构建 CAR 导入当前 Store，
  --no-import 关闭导入；CLI 首轮准备发布，生成项目不得声明虚构 registry
  @ipab/cli 版本；使用本地链接命令。输出限项目 dist/ 内或项目外，不穿过符号链接。
  builtin:node-app.v1 离线解析完整 appSchema；register
  set/remove 可接受此只读 builtin 快捷名，
  持久化准确 CID，不能用作任意 App 执行目标。App 定义集中在 app-definition.ts，
  name/version/entry 必填，description 默认空，author/license/icon/i18n 可选；
  supportedSchemas 可选路径声明单个 resources/ 普通 CAR，省略没有 open 支持类型；
  声明时所有执行（含 exec）前校验非空、多根、全 roots 单 block 完整 Bundle
  Schema 定义，CIDv1/DAG-CBOR/SHA-256／canonical／Schema 全部验证。
  拒绝缺 root、重复 roots／records、额外 blocks、坏 hash／路径、控制文件或
  entry 碰撞，复用现有资源和聚合 work／深度预算。build 读取顶层
  supportedSchemas: []（旧省略视为空）明确选择 schemas/ 非隐藏 .json 普通文件，
  无 glob／扫描／符号链接；严格 JSON 完整定义，不是裸 Schema。按实际 CID
  去重排序并生成 resources/supported-schemas.car 和 app.json 字段，空源列表不生成。
  app 不得覆盖生成的 entry/supportedSchemas。通用 Builder／import 对嵌套 CAR
  保持不透明，不 graft 类型依赖；永不自动导入、注册、pin 或 retain 嵌套 roots。
  外层 App 保留其嵌套文件字节，不保证内部块独立可寻址。open 在唯一 App load
  后、spawn 前要求输入 schemaKey 准确在 roots 中，否则明确失败；exec 不根据声明
  改写／解析 argv 或匹配输入。register 仍本地离线，关联不证明声明。
  新 App 完整定义 CID 为 bafyreid3qonq3i2rjekgz7mtarpu4zbfmgg4uhtcjtpijdgrrhdke5opzq，
  builtin 指向新身份，不静默接受旧身份；须重建并显式更新 pin/register。
  profile/runtime 已移除，完整类型 CID 确定 Node 合约。元数据不得改共享定义，
  SemVer／Intl locale tag／非空白／icon 存在检查在 App 专用层，license 只声明，
  不提供 DRM 或控制读写执行。准确新 CID 和有意迁移说明见 docs/reference.md。
  下层 bundle build/inspect/import 永不编译；import 显式验证自足单根 CAR，
  复用 Store put 保存原始 block，不 pin／retain，不执行 App／GC 或启动 daemon；
  导入失败保留 CAR、不回滚共享 block；构建失败只清理本次 staging／临时 CAR，
  不打包或删除旧 staging。完整公共接口与资源路径见 docs/reference.md。
- App build 默认生成独立 `<output-name>.source.car`；`build.includeSource`
  配置默认 true，互斥 `--with-source`／`--without-source` 优先覆盖。
  项目 `.bundle.yaml` 定义源码类型，内置模板生成以 package.json 为入口的
  IPAB App Source；旧项目无定义时只在快照补默认定义，不修改项目。
  源码按项目内嵌套 .gitignore 选择，包含未跟踪内容，不读取机器全局规则；
  强制排除 .git、node_modules、根 dist、活跃输出目录、两个输出和自有 staging。
  快照受 Bundle 预算限制，构建前后核对文件与字节，变化失败；
  符号链接、忽略定义／入口／显式构建输入失败。App 只保存 source:{cid} 弱关联，
  不内嵌源码 CAR 或 blocks，不自动 fetch/import/pin/retain 源码。
  CLI 默认仅导入 App，源码需独立导入及保留。两个产物分别原子提交，不承诺
  跨文件事务或任意环境可复现；关闭不删除既有源码产物。新增 source 改变 App
  类型身份，旧包须重建并显式更新 pin/register，不能静默接受旧类型。
- Init 支持 `--template node|web-app|显式本地目录`；本地 `ipab-template.json`
  v1 只列 source/target/render 文件映射，不运行脚本或安装模板依赖。
  默认 Node 编译不变；显式 `build.strategy=ipab-prebuild` 执行可信项目代码，
  先按 typecheck 配置运行严格本地 tsc，再调用准确 npm/pnpm 的指定 script，
  只调用 scripts.ipab-prebuild，不回调 scripts.build，也不运行额外 lifecycle
  hooks
  或让 pnpm 自动下载／切换版本。scripts.build 保持 ipab build。
  未声明 packageManager 时优先沿用 npm_execpath 标识的 npm/pnpm，
  没有上下文才使用 npm；明确声明始终优先并校验准确版本。
  钩子只写本次 `IPAB_BUILD_DIR`，不得清除
  `IPAB_BUILD_CHAIN` 后递归构建；IPAB 从新产物组装并保留原程序字节。
  入口必须为有效 UTF-8 Node CJS，只解析不执行，不将 ESM 原文冒充 CJS；
  Bundle 仍只有 resources/app.cjs 一个 Node 运行入口，资源从明确选中的产物路径收集。
  流错误、诊断抛错或取消须停止本次钩子进程树并等待关闭，失败不替换旧 CAR。
  模板源码位于 templates/node 与 templates/web-app，CLI 构建时输出经过准确类型、
  完整性和渲染校验的 dist/builtins/template.{node,web-app}.car，随 CLI 包交付；
  运行时只读 CAR，不重建或读取仓库模板源码，不执行安装 hooks。
  内置 Web 快捷名默认提供所安装框架包的准确版本；本地未发布开发须显式覆盖
  webAppDependency=file:...，目录／CAR／CID 使用时始终显式提供参数。
  Vite 只在项目构建期执行。
  框架提供宿主页／opaque iframe、显式方法及事件；不是 Node 安全沙箱，
  服务就绪后默认打开系统浏览器，openBrowser:false 关闭；
  框架保留的 App 参数 --no-open 优先禁止打开，打开失败报告 URL 并保留服务。
  不替换 IPAB 输出最终提交规则。协议与限制见 docs/reference.md 和框架 README。
- Template 新契约是专用 Content Bundle 数据，不是 App。完整 templateSchema
  用 encodeSchema 编码，离线类型 alias builtin:project-template.v1 对应
  bafyreihydmyx5qvemxlidzyc7yflwxnidllorpaq7xoxlh264ozjnalqra；
  入口 template.yaml 固定 version:1/root:project/render.suffix:.liquid。
  默认 node 是离线预构建 CAR Bundle；init 的 --template 接受同类型本地目录、
  自足单根 CAR、准确 CID 或 ready named pin，templateCid 返回准确内容身份。
  project/ 是输出布局，LiquidJS 渲染 .liquid 后去后缀，其他文件原字节复制，
  包括 binary/dotfiles；不做 HTML autoescape，json filter 负责 JSON 引号。
  name 为 init NAME 提供的 required string，description 为 string/default:""；
  额外参数由 repeatable --param KEY=VALUE 提供，string literal，其余 JSON。
  严格参数、路径／大小写碰撞、UTF8、字节／路径／渲染预算和取消校验；
  无 include/render/layout/file IO、自定义 JS filters、hooks 或 install。
  web-app 是预构建 Template Bundle；旧 ipab-template.json 仅临时兼容；
  同时有 .bundle.yaml 必须走新类型校验，不能降级到旧映射。
- 用户 Alias 由具名 pin 替代；打开状态库时删除旧 aliases 表，
  不兼容、解析、展示或迁移旧数据，pin list JSON 仅返回 items/pending。
  pin add 验证完整 DAG 与适用 Bundle/Schema 类型信息，使用稳定随机 owner 和
  原后端 hold；pending/deleting 操作可重试，ready 才解析。rename 只原子改名，
  不触发 Store 操作，不改 register/历史 CID。执行/历史恢复必须跳过 named pin
  owner。list/show 合并只读内置 pin 与用户本地登记；内置 Schema／模板来自
  安装包，计算并验证准确 CID，提供离线 block 源，不伪造用户 Store owner。
  builtin:node-app.v1、builtin:project-template.v1、builtin:template.node、
  builtin:template.web-app 显示 built-in 来源与 builtin:true；保留 builtin
  命名空间，禁止 add/delete/rename，普通用户 pin 的持久保留规则不变。
  --kind 只接受 bundle/schema，普通 content
  仍可 pin；--type 支持准确 schema CID、Schema pin 短名与 builtin，按 AND 过滤。
- history list 使用逐条记录显示完整 CID，argv 仅 join 空格后转义控制字符，
  不截断或用 pin 替代 CID。exec --log APP / open --log CONTENT 是按次调试开关，
  要求 history 开启；默认 stdio inherit，日志模式只接管 stdout/stderr，
  stdin 不记录。日志按完整执行 ID 保存在状态目录，show 只关联现存文件，
  删除历史先清理日志，失败保留记录供重试；不递归清除未知文件或触发 Store GC。

## Direct scripts and standard boundary

用户明确要求参考现有工程脚手架，并确认
“沿用当前项目的直接工具命令”。本仓库据此使用标准工具命令和根 check
的 fail-fast 链，不引入只为转发命令而存在的 `scripts/<same-name>.mjs`。

这与标准 `AGENTS.md` 的固定同名脚本接口条款存在已知差异，
不是标准检查已通过或可删除标准条款的声明。标准文件完整保留；
项目选择只记录在本文件。不要通过修改标准或未来 Check 资产掩盖这一差异。

## Node selection

2026-11-23 搭建时读取官方 index 与 release schedule，选择 LTS `26.13.1`。
更新 Node 时重新获取不超过一小时的新鲜证据；禁止用旧文档代替。
根兼容范围和 CI 矩阵参考原工程，不自动推导尚不存在的 code package 最低版本。

## Publishing

当前有只读手动 Release validation 和单包 publish-npm workflow，
五个 code package 已登记交付，根保持 private。
它要求当前 dispatch 的准确 main SHA 已有新版日常 push 矩阵/汇总成功，
再运行三种 Node 完整检查与真实安装链路，产生 Release verification (v2)。
日常 CI verification (v2) 与旧 Release verification (v1) 不是完整发布证据。
Trusted Publisher 使用 publish-npm.yaml 和 environment npm，允许直接 npm
publish。
每包 deliverable.yaml 只声明 type:npm，tag 为准确 @ipab/<包名>@<版本>，
从同目录 package.json 派生，tag 后缀必须等于该包准确版本；
main dispatch 只 dry-run，准确 SHA 日常及完整远程证据缺失时阻止。
RC 从 rc.0 连续增长，用 rc dist-tag；稳定版用 latest。发布前核对目标版本缺失、
全部 runtime/peer 依赖已存在，registry 失败不代表缺失。
不复制原仓库的版本／SHA 授权，不自动发布、推 tag、修改已有 dist-tag 或上传远端产物。
根固定已发布 devtool.publish-gate 0.2.0-rc.0，五个实际发布包的 prepublishOnly
准确为 publish-gate check --workflow ci.yaml --workflow
release-validation.yaml。
重复 workflow 的整体成功检查由共享门禁提供；IPAB 仍保留更严格的
main-push/main dispatch、完整矩阵与汇总检查。使用 native pnpm 目录发布执行
真实生命周期，tarball 仅用于预检，不能用 tarball publish 绕过钩子。
PNPM_CONFIG_* 传递 public/channel/provenance/dry-run 及当前有效 registry，
main dispatch 始终 dry-run，不自动运行证据 workflow，不授权 IPAB 发版。
