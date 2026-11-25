# Contributing

使用 `.node-version` 指定的 Node 和根 `packageManager` 指定的 pnpm：

```sh
pnpm install
pnpm check
```

根 check 依次执行格式、构建、类型、全仓库 lint、门禁脚本测试、成员完整覆盖率
和交付包检查，仍是提交前的全量质量验证。
不能通过排除源码、删除测试、放宽门槛或吞掉错误来取得通过结果。
当前 `apps/cli` 是 private code package，包含真实 CLI、子进程和 writable
Store 回归测试；根不另建独立测试套件。没有 npm 交付项，包发布检查无任务。

## 工程命令

| 命令                 | 用途                                               |
| -------------------- | -------------------------------------------------- |
| `pnpm build`         | Turbo 按依赖顺序构建成员                           |
| `pnpm typecheck`     | 检查根配置及所有成员类型                           |
| `pnpm lint`          | 全仓库 lint，包括根配置、成员源码与测试            |
| `pnpm format-check`  | 只读格式检查                                       |
| `pnpm format`        | 有意修改格式时使用                                 |
| `pnpm test`          | 单轮成员测试，不开启覆盖率                         |
| `pnpm test-ci`       | 日常成员测试，显式不选 `release-e2e`，不开覆盖率   |
| `pnpm test-coverage` | 成员覆盖率及四项门槛检查                           |
| `pnpm test-tooling`  | exact-SHA CI 证据与矩阵门禁脚本回归                |
| `pnpm lint-package`  | 构建并检查声明该命令的交付包                       |
| `pnpm check-ci`      | 日常完整静态检查、门禁脚本测试与关键行为验证       |
| `pnpm check`         | 全部静态检查、门禁脚本测试、完整覆盖率与包检查     |
| `pnpm check-release` | `pnpm check` 后执行真实 `pnpm test-pnpm`，失败即停 |
| `pnpm clean`         | 清理根和直接成员的 dist、coverage、Turbo 输出      |

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

`pnpm build && pnpm test-pnpm` 验证真实 pnpm 开发链路：先打包并在独立临时目录
安装 CLI tarball，再从安装后的 CLI 离线列出内置 pin、
初始化 Node 与 Web App 模板、实际安装依赖、执行生成项目原有的
`pnpm typecheck`／`pnpm build` 并检查 CAR。使用当前设备 registry，
关闭 Corepack 联网，输出和本地 Store 均隔离，完成后清理。
CLI 的内部库依赖显式链接到已构建 workspace，暂不声称验证其他四个包的 npm 交付；
Web 项目显式传入本地框架 file 参数，不依赖尚未发布的 registry 版本。
临时安装配置沿用仓库对 esbuild 构建脚本的明确许可，不修改设备全局策略。
生成项目仍实际安装依赖，不修改其 packageManager 或 build 脚本；
缺失／损坏内置 CAR 必须明确失败，不能回退仓库模板源码。
仅发布前的默认环境和 Node 兼容矩阵执行，不再进入每次 PR/main push。

## Workspace

- 可执行应用放在 `apps/`，公共代码放在 `packages/`。
- 共享第三方依赖放在 pnpm catalog，内部依赖使用 `workspace:*`。
- 根包保持 private，不发布整个 workspace。
- TypeScript 源码和测试保持 strict，并由 type-aware ESLint 检查。
- 每个 code package 扩展根 TypeScript 配置，并独立声明 build/typecheck。
- 测试用共享 `vitest.config.ts`，在成员目录显式指定
  `--root . --config ../../vitest.config.ts`。
- `pnpm test` 为单轮非 coverage 测试，`pnpm test-coverage` 执行覆盖率。
  同一个 worktree 的 `pnpm check`／`pnpm test-coverage` 必须顺序运行；
  Vitest 对共享 coverage 目录加锁，另一轮运行未结束时不要删除锁或报告目录。
  需要并行验证时使用独立 worktree，或直接调用 Vitest 并明确指定独立
  `--coverage.reportsDirectory`；这不替代提交前的根 check。
- 共享或资源紧张的开发机可设置 `VITEST_MAX_WORKERS=1` 后执行上述命令；
  Turbo 显式传递并将该值纳入各测试任务缓存，避免不同 worker 设置误用缓存。
  这只限制并发，不改变测试选择、timeout 或覆盖率门槛。
- 全部四项全局覆盖率门槛为 90%，包含未测试源码，不使用 `passWithNoTests`
  隐藏缺失测试。日常测试不生成部分 coverage 报告或将其冒充全量覆盖率；
  完整门槛由 `pnpm check` 和发布前验证执行。
- 既有根工具脚本及其标准接口差异保留；新增成员命令遵循
  `node scripts/<same-name>.mjs`，共享逻辑放 `scripts/lib/`，必须传播失败。
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
22.15.0、24.11.1 三个环境及全部格式、构建、严格类型、type-aware lint、
门禁脚本回归与包检查。`CI verification (v2)` 要求全部 job/matrix 成功，
不是完整发布证据。

成员 `test-ci` 使用同一共享 Vitest 配置、相同的成员 root，
通过 `--tags-filter '!release-e2e'` 选择测试；新测试默认进入日常验证。
只有反复编译的构建变体标记为 `release-e2e`：
重复构建与类型错误后的产物保护、YAML/JSON Schema 集合确定性、
完整 Web/Vite 模板、prebuild 各类输出拒绝、源码输出开关、前后端多配置编译。
这些测试保留所有原断言、超时和完整执行入口，不通过 `skip` 或环境变量隐藏。

日常仍保留真实 strict tsc/依赖打包/CAR/独立源码 Bundle 冒烟、
构建后 pin/rename/exec、动态依赖及不安全路径拒绝、编译流错误回归，
以及全部 runtime、子进程取消、IPC、持久保留、Schema/模板、Bundle、
Builder 和 Store 集成测试（包括 Node 22 GC deadline 回归）。
不按 integration 文件名或目录整体排除。既有真实离线 Kubo daemon 测试仍由
`KUBO_REAL_TEST=1` 显式启用；它原先不在默认 CI 中，此次不改变该约定，
也不访问共享 daemon。

Turbo 为 `test-ci` 单独缓存，依赖成员自身 `build`，确保 CLI 子进程使用当前
dist；测试源码、成员脚本、共享 Vitest 配置与 `scripts/lib/` 参与缓存失效。
它不写 coverage，也不与完整 `test-coverage` 共享任务缓存。

### 发布前完整验证（只读）

需要准备发布时，从 **main** 手动触发
[Release validation](.github/workflows/release-validation.yaml)，输入当前 dispatch
选定的完整 main SHA。输入必须等于 workflow 自身 `head_sha`，不能用另一个
提交的 workflow 状态为目标提交背书；main 前移后需要重新选择并验证新的准确 SHA。

1. 先核对 checkout SHA、main ancestry，以及 GitHub API 中该准确 SHA 最新的
   `CI` main-push run。必须是本仓库的 push/main/ci.yaml 且成功，
   并核实该 run 的准确 attempt 中 `Quality default`、两个 Node 矩阵、
   `CI verification (v2)` 全部唯一且成功；缺失、失败、取消、跳过、API
   不可用均阻止后续流程，不用 release-local 重跑来代替已有 main-push 证据。
2. 冻结安装，在默认 Node、22.15.0、24.11.1 上执行真实
   `pnpm check-release`：完整 `pnpm check`（不带 tag filter，所有测试及四项
   90% 覆盖率门槛）加临时项目真实安装/类型检查/构建/CAR 验证。
3. 只有证据检查与全部完整矩阵成功，才产生 `Release verification (v2)`。
   旧 `Release verification (v1)` 及新的日常汇总均不能单独作为完整发布证据。

该 workflow 是 dry-run 验证，不含 publish、tag、dist-tag、远程制品上传或
写权限，当前仍没有 npm 交付项或部署操作。未来发布流程还必须校验完整验证
workflow 本身的准确 SHA、main dispatch 来源、全部 full matrix 与 v2 汇总成功；
只核对 job 名称或仅运行本地 `pnpm check-release` 不构成发布授权/远程证据。

迁入真实 npm 包时再登记包内 `deliverable.yaml`，补齐源码链接、exports、
delivery allowlist、许可证、source/declaration maps 和 `publint --strict`。
发布只使用授权的准确包／版本／提交及 Trusted Publishing，
保留成功的准确 SHA main CI 门槛，不保存 npm token 或复制个人 registry 配置。

代理先读 [AGENTS.md](AGENTS.md) 和 [项目指导](docs/agent-project.md)。
