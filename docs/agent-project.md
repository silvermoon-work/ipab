# Project Guidelines

## Scope

本仓库是 IPAB（InterPlanetary Application Bundle）的独立工程 workspace。
当前 `apps/cli` 已实现确认的 CLI、Node 子进程 profile、独立 IPC Space context、
本地元数据及 Store owner 协调。普通 App argv/stdio 取代早期单 CID Task 输入；
关联管理叫 register，不是 apps；open 不提供临时应用覆盖。
Content Bundle 与 Store 已迁入 `packages/bundle` 和 `packages/ipfs-store`，
名称为 `@ipab/bundle` 与 `@ipab/ipfs-store`；CLI 和 Bundle 使用
`workspace:*` 引用 Store。`@ipab/bundle-builder` 也为 private；
Schema 编码与校验仍在统一的 Bundle runtime，已移除专用 Schema Bundle Builder。
四个 code 成员均 private，不迁移旧发布归属。
Store 的 ipfs-access/ipfs-payload 基础依赖仍使用原发布包，未迁入本仓库。
该 Node runtime 不是沙箱，不宣称隔离不可信程序。

## Engineering

- 使用根 `.node-version` 的准确开发 Node 和 `packageManager` 的准确 pnpm。
- workspace 为 `apps/*` 与 `packages/*`；共享依赖使用 catalog，内部依赖使用
  `workspace:*`。
- 根包及 CLI 成员 private，CLI 非 npm 交付项。验证执行实际业务源码／测试；
  没有交付成员时 lint-package 零任务不代表发布验证。
- 沿用参考工程的 Turbo 依赖顺序与缓存，根目录统一执行 ESLint/Prettier。
- TypeScript strict 与 type-aware lint 覆盖所有成员源码和测试。
- 根 typecheck 显式检查共享 TypeScript 配置；成员必须声明自己的 typecheck。
- Vitest 在每个 code package 的 cwd 中以
  `--root . --config ../../vitest.config.ts` 运行。
- 全部四项覆盖率门槛为 90%，包含未测试源码，失败必须传播。
- 提交前执行 `pnpm check`；局部验证使用成员命令或 Turbo filter。
- 当前设备的 registry 由设备配置决定，不在仓库中写镜像或凭据。
- 只在实际交付成员声明 `lint-package: publint --strict`，根通过 Turbo 调用。
- 不复制参考工程的业务包、历史生命周期记录、发布授权或个人配置。
- 新成员 minimum engines.node 为 22.15.0，所有适用成员保持同一 minimum；
  不自动提高消费者最低环境。
- 迁入包保留原 MIT LICENSE、CID／协议与存储协调标识。private workspace
  使用统一的开发最低环境，旧发布包的消费者最低环境不变。
- Store 的 node:test 测试已改用 Vitest 的 test/onTestFinished/afterAll 和
  fake timers，保留原业务断言；真实 Kubo 测试使用独立离线仓库，
  `KUBO_REAL_TEST=1` 启用，绝不对共享 daemon 执行 GC。
- 新成员脚本按完整标准使用 `node scripts/<same-name>.mjs`，共享逻辑在
  根 `scripts/lib/`，工具失败必须传播；下面的既有差异仅适用于已有根脚本。
- 运行时／CLI 边界、准确 App Schema 和保留策略见 docs/design-overview.md
  与 README.md。只删除自身创建的运行文件，不清空共享 Store 或请求 daemon GC。
- 当前 Bundle 协议见 packages/bundle/README.md：.bundle.yaml 本身是完整类型定义，
  包含必填 name、缺省为空的 description，以及 entry 的 path/schema/contentType/
  defaultValue；默认数据须符合入口 Schema，固定路径不得碰撞控制文件。
  完整归一化定义编码为 CIDv1/DAG-CBOR/SHA-256 block，最多 1 MiB，不分块。
  $defs 和本地 JSON Pointer $ref 在 entry.schema 文档内封闭。
  Schema 只约束入口数据，不约束其他资源；不支持 x-content-ref 或递归内容
  依赖校验，业务依赖交给 App。全部资源仍须通过存储完整性与路径检查。
  Builder 固定 UnixFS/CAR 参数，直接从定义计算类型 block 并纳入内容 CAR；
  不 graft 目录、不读取外部 Schema，保留内容根即可再生类型 block。
  CLI bundle init/build/inspect 支持本地定义、单根 CAR 和 CID；build
  --schema-only
  生成单 block 类型 CAR。两种构建共用 bundle.outputDir，默认根 dist；
  .bundle-ignore 使用 gitignore 风格且自身不打包，初始化写入 /dist/。
  本次输出与活跃默认输出目录不能成为输入，忽略定义/入口须失败；
  只清理自身临时文件，产物替换须 --replace，不覆盖源码或非普通文件。
- App-first 根 init NAME [DIR] 创建普通 private TypeScript npm package；
  根 build [DIR] 严格执行项目本地 tsc、esbuild self-contained Node CJS、
  新建自有 staging、再调用内部通用 Bundle Builder 输出默认 dist/app.car。
  ipab.yaml 是注释式规范配置，旧 ipab.json 仅在 YAML 缺省时兼容，二者并存拒绝；
  严格数据解析拒绝重复键／未知字段／非法类型，不加载 JS 或执行 hooks。
  模板可用默认值并展示 icon 路径、name/description i18n、author/license 和
  supportedSchemas；可选示例仅注释，不创建虚构文件或空目录占位。
  配置声明 src/ 下的 .ts 入口、明确 assets/ 非隐藏资源文件和 app 元数据覆盖；
  入口必须被 tsconfig 实际检查。只允许 Node builtin 外置，不安装依赖或执行 npm
  hooks／JS 配置／App，不 pin。CLI 默认将构建 CAR 导入当前 Store，
  --no-import 关闭导入；CLI private，生成项目不得声明虚构 registry
  @ipab/cli 版本；使用本地链接命令。输出限项目 dist/ 内或项目外，不穿过符号链接。
  builtin:node-app.v1 离线解析完整 appSchema；register
  set/remove 可接受此只读 builtin 快捷名，
  持久化准确 CID，不能用作任意 App 执行目标。App 定义集中在 app-definition.ts，
  name/version/entry 必填，description 默认空，author/license/icon/i18n 可选；
  supportedSchemas 可选路径声明单个 resources/ 普通 CAR，省略没有 open 支持类型；
  声明时所有执行（含 exec）前校验非空、多根、全 roots 单 block 完整 Bundle
  Schema 定义，CIDv1/DAG-CBOR/SHA-256／canonical／Schema／默认值全部验证。
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
  新 App 完整定义 CID 为 bafyreig52cmqw6q55oebwmhhjn6oetx4kgxtqoxlgnvom4wbsrgifyqb4a，
  builtin 指向新身份，不静默接受旧身份；须重建并显式更新 pin/register。
  profile/runtime 已移除，完整类型 CID 确定 Node 合约。元数据不得改共享定义，
  SemVer／Intl locale tag／非空白／icon 存在检查在 App 专用层，license 只声明，
  不提供 DRM 或控制读写执行。准确新 CID 和有意迁移说明见 README.md。
  下层 bundle init/build/inspect/import 永不编译；import 显式验证自足单根 CAR，
  复用 Store put 保存原始 block，不 pin／retain，不执行 App／GC 或启动 daemon；
  导入失败保留 CAR、不回滚共享 block；构建失败只清理本次 staging／临时 CAR，
  不打包或删除旧 staging。完整公共接口与资源路径见 README.md。
- 用户 Alias 由具名 pin 替代；旧 aliases 表保留但不作为 pin 解析或自动迁移。
  pin add 验证完整 DAG 与适用 Bundle/Schema 类型信息，使用稳定随机 owner 和
  原后端 hold；pending/deleting 操作可重试，ready 才解析。rename 只原子改名，
  不触发 Store 操作，不改 register/历史 CID。执行/历史恢复必须跳过 named pin
  owner。list/show 只读本地登记；--kind 只接受 bundle/schema，普通 content
  仍可 pin；--type 支持准确 schema CID、Schema pin 短名与 builtin，按 AND 过滤。

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

当前没有发布 workflow、发布门禁依赖或 npm 交付声明。
迁入真实交付包时再建立单包发布流程并核对新仓库的 Trusted Publisher，
不复制原仓库的版本／SHA 授权，不自动发布或重命名已有包。
