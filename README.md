# IPAB

InterPlanetary Application Bundle 的独立工程仓库。

当前仅包含工程脚手架；尚未迁入 `content-bundle`、宿主或示例 App，
也没有实现 `open` / `apps` 命令、配置 npm 交付项或发布流程。
本次搭建参考 `silvermoon-work/okr-agent` 的共享工程配置，不复制其业务包、
历史生命周期资料或个人配置。

## 设计概览

[IPAB Design Overview](docs/design-overview.md) 汇总内容包、DAG-CBOR Schema、
content refs、App Bundle、默认应用关联、快照及 Store 的设计方向，
并区分已确认原则、当前实现与尚未定稿的接口。

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
apps/                  预留可执行应用目录，目前为空
packages/              预留公共包目录，目前为空
docs/agent-project.md  项目工程指导
pnpm-workspace.yaml   workspace、catalog 和安装策略
turbo.json             依赖顺序与缓存
tsconfig.json          严格 TypeScript 基础配置
vitest.config.ts       各 code package 共用的测试与覆盖率配置
.github/workflows/ci.yaml
```

不创建占位业务包来制造构建或测试结果。当前 `build`、成员 `typecheck`、
`test`、`test-coverage` 和 `lint-package` 会报告零 workspace 任务；
根 TypeScript 配置、全仓库 lint 和格式检查仍实际运行。
这只能验证脚手架，不能证明尚未迁入的代码通过了测试。

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

根据用户确认，脚本使用直接工具命令，不增加同名转发脚本。
标准 [AGENTS.md](AGENTS.md) 的旧脚本接口约定与这一选择的差异，
明确记录在 [项目指导](docs/agent-project.md)，不声称标准接口检查已经通过。

覆盖率包含未测试的成员源码，branches/functions/lines/statements 均为 90%。
每个 code package 必须以自己的 root 运行共享 Vitest 配置，
配置复用不代表根目录存在多项目测试 runner。

## 后续迁入包

共享工具版本放入 catalog，内部依赖使用 `workspace:*`。成员分别声明 build、
typecheck、test、test-coverage；ESLint 和 Prettier 从根目录统一执行。

成员测试可直接使用标准工具：

```sh
pnpm --filter <package-name> exec vitest run --root . --config ../../vitest.config.ts
pnpm exec turbo run test --filter=<package-name>
```

直接选择成员不会自动构建依赖；依赖感知操作使用 Turbo。
只有明确登记为 npm 交付项的成员才添加 `lint-package: publint --strict`。
迁移前不修改已有包的名字、版本、发布归属或 Trusted Publisher。

更多要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。
