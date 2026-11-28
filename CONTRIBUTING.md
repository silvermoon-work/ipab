# Contributing

使用 `.node-version` 指定的 Node 和根 `packageManager` 指定的 pnpm：

```sh
pnpm install
pnpm check
```

根 check 依次执行格式、构建、类型、全仓库 lint、成员 unit/mock 测试
和交付包检查，是提交前的日常质量验证，与 CI 使用的 check-ci 范围一致。
真实构建／执行链路和服务／持久存储集成测试只在发布前完整验证中执行；
check-release 保留全部测试、四项 90% 覆盖率门槛和交付安装 smoke。
不能通过排除源码、删除测试、放宽门槛或吞掉错误来取得通过结果。
五个 code package 显式登记为 npm 交付项；Store、Bundle、Builder、CLI 当前已发布
`0.1.0-rc.2`，Web App 保持已发布的 `0.1.0-rc.1`；
根 workspace 保持 private。每个交付包都有 `deliverable.yaml`、`files` 清单和
真实 `publint --strict` 检查，不把零任务当作发布验证。
Check Spec 组件和 Check viewer App 是 private 成员，不加入这五个 npm 交付项。
private `@ipab/pointer-worker` 是 Scope / Variable 服务（Cloudflare Worker），
不属于 npm 交付项；CLI 已接入其授权与共享 Name/HEAD 同步。
portable Scope 协议在 Bundle 包复用；创建 Scope 使用受保护、origin-bound API
key（安全 STDIN 设置、查询掩码）与 Owner 持钥证明。每 Scope 一个 SQLite DO
原子协调 Variable 内容 CID CAS、freeze/delete 和 nonce；公开读、准确 ID
certificate 写，不设过期或历史 revision，无旧 Swarm/Pointer fallback。
生成 Worker binding types 后须检查配置／类型一致。
完整 [Onboarding](docs/onboarding.md) 及
`packages/pointer-worker/test/mvp.test.ts` 覆盖真实 checksum-installed Kubo、
独立 repo/key/PeerID/ports、receiver 缓存 miss 后双向新内容获取、CLI 退出常驻，
以及 Owner freeze 中断与 resume。测试只控制本次创建并验证 PeerID 的节点；
不读取 HOME 身份或管理已有 daemon。首版仅 LAN/VPN。
根 `ipab build` 只做通用组装，App 准备由项目显式调用 `prepareApp` 完成；
迁移及验收边界见 [MVP 实现](docs/mvp-implementation.md)。
Check SDK 同样 private；其显式模板的真实测试覆盖 STDIN 输入、正常业务失败报告
提交，以及原始 Check model 根 CID 在 App／Result 中的准确复用。
它们的日常测试包括有界 Markdown 引用、静态校验器、移动／桌面 hydration，
以及真实 App CAR 读取示例 Content Bundle 后的内容 SSR 与关闭行为。
Check Viewer 的仓库构建使用独立临时 CLI 状态目录，不读取或修改设备已有的
Store 配置，完成后只清理本次创建的状态目录。
Bundle／Builder 测试覆盖 Markdown frontmatter、入口字节保留和 Agent Skill
示例 CAR；CLI 测试覆盖通用 Template
Bundle 初始化，不从类型 Schema 生成默认数据。
Bundle entry 不含 defaultValue；Template
parameters 的 default 仍是渲染参数默认值。
Builder 的各测试任务将 Skill 示例
源文件纳入 Turbo 缓存输入，不将示例生成的 `dist/` 作为输入或资源。

## 工程命令

| 命令                 | 用途                                                     |
| -------------------- | -------------------------------------------------------- |
| `pnpm build`         | Turbo 按依赖顺序构建成员                                 |
| `pnpm typecheck`     | 检查根配置及所有成员类型                                 |
| `pnpm lint`          | 全仓库 lint，包括根配置、成员源码与测试                  |
| `pnpm format-check`  | 只读格式检查                                             |
| `pnpm format`        | 有意修改格式时使用                                       |
| `pnpm test`          | 单轮成员测试，不开启覆盖率                               |
| `pnpm test-ci`       | 日常成员 unit/mock 白名单，不开覆盖率                    |
| `pnpm test-coverage` | 成员覆盖率及四项门槛检查                                 |
| `pnpm lint-package`  | 构建并检查声明该命令的交付包                             |
| `pnpm check-ci`      | 日常完整静态检查与关键行为验证                           |
| `pnpm check`         | 与 check-ci 相同的日常静态检查、unit/mock 与包检查       |
| `pnpm check-release` | 静态检查、全部测试及覆盖率、包检查、安装 smoke，失败即停 |
| `pnpm clean`         | 清理根和直接成员的 dist、coverage、Turbo 输出            |

## 依赖安装与集成验证

若脚本启动前报告 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 且提示
`version not present in registry manifest`，先检查当前设备 registry 的元数据
和锁文件变更，不关闭 `minimumReleaseAge` 或 `verifyDepsBeforeRun`。
确认缺失的传递依赖后，可用
`pnpm -r update --lockfile-only --depth Infinity <package-name> ...`
定向重新解析，再执行 `pnpm install --frozen-lockfile` 和 `pnpm check`。
不要将设备专用 registry／代理地址写入共享锁文件。

`pnpm build` 将 `templates/node` 与 `templates/web-app` 构建为
`apps/cli/dist/builtins/template.{node,web-app}.car`，检查准确模板类型、CAR 完整性
和实际渲染；失败阻止 CLI 构建成功。CLI 交付清单包含这些 CAR，
运行时不重建模板，也不读取仓库模板目录。Turbo 将模板源码纳入 CLI 构建缓存键，
CLI 的 test 与 test-coverage 先构建自身以准备资源。

CLI 同时将 `skills/ipab` 构建为 `dist/builtins/skill.ipab.car`，校验 Markdown
入口并通过运行时内置加载器复核 CID。Skill 源码参与 CLI build 的 Turbo 缓存键，
运行时不读取仓库源码；安装到 Agent 与默认加载由消费端独立处理。

`pnpm build` 后执行 `pnpm test-package-smoke` 只做 npm 交付安装 smoke：
从 `deliverable.yaml` 发现五个非 private 交付包，分别打包为 tarball，
在独立临时消费目录从这些 tarball 安装，加载公开 JS 入口并运行 CLI `--version`。
CLI 另用隔离状态目录执行 `pin list`，确认安装后的内置 Skill CAR 可加载；
不读取或修改用户状态。
内部依赖用临时 pnpm overrides 映射到本次 tarball，不链接 workspace；
不安装开发工具、不做类型编译，不创建模板项目、不构建或启动 Viewer。
业务行为由各包现有测试覆盖，不在此重复。
使用当前设备 registry，关闭 Corepack 联网；临时配置只允许既有 esbuild 构建脚本，
不修改设备策略、个人 Store 或 CLI 状态，结束后清理本次临时目录。
该 smoke 仅在发布前的默认环境和 Node 兼容矩阵执行，不进入每次 PR/main push。
通用机制由 private 试验包 `@silvermoon-work/devtool.package-smoke` 提供：
通过真实 pnpm workspace 列表发现非 private 成员、打包、隔离安装及清理，
不参与 npm 发布，不自动构建源码。根命令直接调用
`package-smoke --verify scripts/package-smoke.mjs --allow-build esbuild`；
`scripts/package-smoke.mjs` 只声明 IPAB 的基本启动验证，复制到临时消费目录执行，
其 package imports 解析到安装后的 tarball。验证文件须是独立 `.mjs`，
不依赖原目录的相对模块或资源。命令有五分钟超时，失败立即停止；
临时目录不是安全沙箱。

## Workspace

- 可执行应用放在 `apps/`，公共代码放在 `packages/`。
- 共享第三方依赖放在 pnpm catalog，内部依赖使用 `workspace:*`。
- 根包保持 private，不发布整个 workspace。
- TypeScript 源码和测试保持 strict，并由 type-aware ESLint 检查。
- 每个 code package 扩展根 TypeScript 配置，并独立声明 build/typecheck。
- 测试用共享 `vitest.config.ts`，在成员目录显式指定
  `--root . --config ../../vitest.config.ts`。
- `pnpm test` 为单轮非 coverage 测试，`pnpm test-coverage` 执行覆盖率。
  同一个 worktree 的 `pnpm check-release`／`pnpm test-coverage` 必须顺序运行；
  Vitest 对共享 coverage 目录加锁，另一轮运行未结束时不要删除锁或报告目录。
  需要并行验证时使用独立 worktree，或直接调用 Vitest 并明确指定独立
  `--coverage.reportsDirectory`；这不替代提交前的根 check。
- 共享或资源紧张的开发机可设置 `VITEST_MAX_WORKERS=1` 后执行上述命令；
  Turbo 显式传递并将该值纳入各测试任务缓存，避免不同 worker 设置误用缓存。
  这只限制并发，不改变测试选择、timeout 或覆盖率门槛。
- 全部四项全局覆盖率门槛为 90%，包含未测试源码，不使用 `passWithNoTests`
  隐藏缺失测试。日常测试不生成部分 coverage 报告或将其冒充全量覆盖率；
  完整门槛由 `pnpm test-coverage` 和 `pnpm check-release` 执行。
- 根检查编排使用固定的 `npm-run-all2@8.0.4` 提供的 `run-s`：
  按参数顺序执行，首项失败立即停止并返回非零；不并行、不吞掉失败。
  该稳定版本兼容 Node 22.15.0；9.x 要求更高的 Node，不能自动升级。
  根 `test-ci` 直接调用 Turbo，成员直接调用 tsc、Vitest 和 publint，
  不保留纯转发文件。根 scripts 只保留 link-cli 与项目 package-smoke 验证；
  成员中生成 CAR／AJV 等实际构建逻辑保留，使用标准 Node 子进程调用本地 tsc。
  此命令优先约定及与标准脚本接口的差异见项目指导。
- 所有适用成员 minimum engines.node 保持 22.15.0；修改最低消费环境需明确决定。

对单个成员执行依赖感知验证：

```sh
pnpm exec turbo run test --filter=<package-name>
```

不要把成员测试移到根目录或人为维护包列表。Turbo 读取真实 workspace
及依赖图；共享配置的变化参与缓存失效。

`clean` 只移除受信任 workspace 布局中的指定生成目录，不清除依赖、内容 Store
或其他仓库。不要对不可信目录布局执行清理。

## CI 与交付

### 日常快速验证

所有 PR 和 main push 执行冻结安装与 `pnpm check-ci`，保留默认 Node、
22.15.0、24.11.1 三个环境及全部格式、构建、严格类型、type-aware lint
与包检查。`CI verification (v2)` 要求全部 job/matrix 成功，不是完整发布证据。
本地 `pnpm check` 使用同一日常范围，不再运行 E2E 或完整覆盖率。

成员 `test-ci` 使用同一共享 Vitest 配置和成员 root，
通过 `--tags-filter '(unit or mock) and !release-e2e'` 显式允许 unit/mock。
未标记的新测试不会自动进入 CI；每个测试必须在用例或 suite 上声明分类。
分类依据测试边界，不依据耗时或文件名：

- `unit`：隔离函数、解析／校验、内存数据结构、组件及本地文件适配器单元测试。
  可以用临时文件、内存 CAR 和模拟 DOM；不启动真实应用、服务或构建链路。
- `mock`：外部进程、网络／服务、应用 context 或存储端口被替换的测试。
  例如 package-smoke 的 spawn mock、浏览器 bridge mock 和内存 Store source。
  spy 后继续调用真实 spawn／服务不算 mock。
- `release-e2e`：真实 tsc/esbuild/Vite 构建链路、启动构建结果或 CLI 子进程、
  App exec/open、真实 HTTP 服务、Store／SQLite 持久保留及恢复等集成验证。
  不论快慢都只在发布前测试中跑；不能标 unit/mock 来绕过此边界。

混合文件逐用例分类，纯同类 suite 可以继承分类。CI 的显式 E2E 排除优先于
unit/mock 标签，避免被错误双标的测试进入日常验证。
全部原断言、超时和完整执行入口保留，不通过 skip、删测试或降低覆盖率提速。
完整执行使用 `pnpm check-release`；开发时可以显式用 `pnpm test` 或
`pnpm test-coverage` 调试完整测试，它们不是日常 CI 入口。
相关构建保留取消信号，清理前等待在途子进程关闭；不访问共享 daemon 管理接口。

Turbo 为 `test-ci` 单独缓存，依赖成员自身 `build`，确保导入当前构建资源；
测试源码、成员脚本与共享 Vitest 配置参与缓存失效。
它不写 coverage，也不与完整 `test-coverage` 共享任务缓存；
测试分类、成员过滤命令和共享配置变化均使缓存失效。

修改元数据、模板或包导出时，先定向验证，再跑原门禁：
纯 App 元数据和内存模板渲染进日常测试；资源路径、真实模板编译、
CAR 替换失败保护、Viewer 三种输入和跨账号发布仍在完整测试中执行。
修改公开入口后可先构建并运行 `pnpm test-package-smoke`，以早点发现
消费端的导入错误；不能用 workspace import 或定向 coverage 代替发布验证。
成员需要增加跨包测试输入时，在成员 `turbo.json` 继承根任务，
用 Turbo 的 `--dry=json` 确认 `dependsOn`、`VITEST_MAX_WORKERS` 和
`coverage/**` 没有丢失。Check Viewer 的完整测试还依赖仓库 Check 示例；
CLI 构建只依赖两种内置模板，完整测试另依赖 React Viewer 模板。

### 发布前完整验证（只读）

需要准备发布时，从 **main** 手动触发
[Release validation](.github/workflows/release-validation.yaml)，输入当前 dispatch
选定的完整 main SHA。输入必须等于 workflow 自身 `head_sha`，不能用另一个
提交的 workflow 状态为目标提交背书；main 前移后需要重新选择并验证新的准确 SHA。

1. 先核对 dispatch 的准确 main SHA、checkout SHA 和 main ancestry。
   完整验证不重新实现日常 CI 证据门禁；两个 workflow 的最新执行结果
   在实际发布生命周期中由固定已发布的 publish-gate 统一检查。
2. 冻结安装，在默认 Node、22.15.0、24.11.1 上执行真实
   `pnpm check-release`：格式、构建、类型、lint、完整 test-coverage
   （不带 tag filter，所有测试及四项 90% 覆盖率门槛）、包检查，
   最后五包 tarball 安装、JS 入口加载和 CLI 版本 smoke。
3. 只有目标检查与全部完整矩阵成功，才产生 `Release verification (v2)`。
   旧 `Release verification (v1)` 及新的日常汇总均不能单独作为完整发布证据。

该 workflow 是 dry-run 验证，不含 publish、tag、dist-tag、远程制品上传或
写权限。每个 workflow 自己负责完整测试选择、矩阵及汇总失败传播。
仅运行本地 `pnpm check-release` 不构成发布授权/远程证据。

### 单包 npm 发布

Trusted Publisher 的约定为 `silvermoon-work/ipab`、
`publish-npm.yaml`、environment `npm`，每个包须允许直接 `npm publish`。
在 GitHub 配置 `npm` environment 的保护规则和所需审批，不放 npm token。
只使用 GitHub-hosted runner 和 npm >=11.5.1 的 OIDC Trusted Publishing。

每个实际发布包的 `deliverable.yaml` 仅声明 `type: npm`，包名和版本由同目录
`package.json` 读取。发布 tag 为 `@ipab/<包名>@<准确版本>`，
由准确包名派生，不另配 tagPrefix。一个 tag 只发布一个包；创建并推送 tag 是对准确包、
版本和提交的显式授权。不得自动创建、移动或批量推送 release tag。
手动 dispatch 只能从 main 选择自身准确 SHA、包名和版本，始终 `--dry-run`；
它仍须满足相同的远程证据与依赖可用性门禁。

本轮单包顺序为 `ipfs-store` → `bundle` → `bundle-builder` → `cli`，
四包已发布 `0.1.0-rc.2`；`web-app` 复用已发布的 `0.1.0-rc.1`，
没有交付源码变更，不重复发布。各包 workspace 依赖由 native pnpm 转换为所引用
包的准确版本，因此必须逐包确认内部依赖可用后再发布下一包。
候选版本变更不是发布授权；确认最终 commit 后逐包批准 tag。

发布 workflow 用 `publish-gate target --json` 选择唯一包，构建并 lint 所选包及
构建依赖，然后使用 native pnpm 在包目录执行 `publish --no-git-checks`。
pnpm 负责 workspace/catalog 转换和打包；不发布 tarball、不跳过生命周期。
唯一的发布资格门禁是已发布 publish-gate 的 prepublishOnly：
它检查 Git/main ancestry、tag、包身份、OIDC、目标版本、RC 连续性、
runtime/peer 依赖可用性，以及两个 workflow 的最新准确 SHA 结果。
关闭 pnpm 的通用分支检查不关闭共享门禁的准确 SHA/main ancestry 校验。
目标版本已存在、RC 不连续、依赖不存在或 registry/API 失败均阻止发布。
Registry 包不存在或 HTTP 错误不是版本缺失的证明。
稳定 `x.y.z` 用 `latest`，`x.y.z-rc.n` 用 `rc`，不支持其他 prerelease；
不会递归发布依赖、上传远端制品或修改已有 dist-tag。

发布包的 `publishConfig.registry` 明确为官方 npm，以满足共享门禁的发布契约；
GitHub-hosted runner 的有效 registry 也必须与之相符，不通过 `--registry`
临时覆盖。
该字段只约束发布，不改变本机 NRM registry、安装或元数据查询的 Tencent 配置。
源码与 declaration/source maps 一起交付，
测试、开发脚本、coverage、配置和依赖目录不进入包。

### 共享发布门禁

根开发依赖固定已发布的
`@silvermoon-work/devtool.publish-gate@0.2.0`，不用 dist-tag alias 或同仓候选。
所有实际发布包准确声明：

```json
{
  "scripts": {
    "prepublishOnly": "publish-gate check --workflow ci.yaml --workflow release-validation.yaml"
  }
}
```

发布 workflow 直接依赖 pnpm 执行包内生命周期，不再比对脚本文本。
重复 `--workflow` 是 AND：
共享门禁检查同仓库、同完整 SHA 的最新 workflow run/当前 attempt 整体
`completed/success`，按文件路径和 API workflow ID 确认身份，并拒绝验证期间
新增 run/rerun/重建及 API/分页失败。显式模式不限制 event/branch，
不检查内部 job/矩阵/step，IPAB 不再额外复制这些门禁。
统一 flaky 规则是取最新执行结果：旧成功之后新 run/rerun 失败就阻断；
不能搜索“曾经通过”的 run 作为替代，也不会自动触发或重跑验证。

标准 `PNPM_CONFIG_REGISTRY/ACCESS/TAG/PROVENANCE/DRY_RUN` 环境配置传入生命周期，
发布专用 registry 为官方 npm，并与 publishConfig 一致，provenance 固定 true，
手动 dispatch 的 dry-run 固定 true，只有显式 tag 授权才是 false。
`PACKAGE_INPUT` 传准确包名，Actions token 以 `GITHUB_TOKEN` 提供；
不保存 npm token，不使用 `--ignore-scripts`，也不自动运行/重跑证据 workflow。
本地测试以 native pnpm 临时目录 dry-run 验证安装后的门禁拒绝非 Actions 上下文，
不假装本地通过了完整远端发布授权。

安装该明确选定的新正式版时，仅为准确
`@silvermoon-work/devtool.publish-gate@0.2.0` 保留 release-age 例外，
替换原 RC 例外；它只允许消费此已发布版本，不关闭全局 supply-chain 策略。
IPAB 发布仍须另行授权，不因接入或门禁检查成功自动发布。

代理先读 [AGENTS.md](AGENTS.md) 和 [项目指导](docs/agent-project.md)。
