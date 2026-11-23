# Project Guidelines

## Scope

本仓库是 IPAB（InterPlanetary Application Bundle）的独立工程 workspace。
当前只初始化工程配置，不迁移业务包，不实现 CLI，也不创建占位应用或测试。
未来的 App profile、open/apps 命令和包迁移由独立需求确认后实施。

## Engineering

- 使用根 `.node-version` 的准确开发 Node 和 `packageManager` 的准确 pnpm。
- workspace 为 `apps/*` 与 `packages/*`；共享依赖使用 catalog，内部依赖使用
  `workspace:*`。
- 根包 private。尚无 code packages，不把零任务结果当作业务验证。
- 沿用参考工程的 Turbo 依赖顺序与缓存，根目录统一执行 ESLint/Prettier。
- TypeScript strict 与 type-aware lint 覆盖未来成员源码和测试。
- 根 typecheck 显式检查共享 TypeScript 配置；成员必须声明自己的 typecheck。
- Vitest 在每个 code package 的 cwd 中以
  `--root . --config ../../vitest.config.ts` 运行。
- 全部四项覆盖率门槛为 90%，包含未测试源码，失败必须传播。
- 提交前执行 `pnpm check`；局部验证使用成员命令或 Turbo filter。
- 当前设备的 registry 由设备配置决定，不在仓库中写镜像或凭据。
- 只在实际交付成员声明 `lint-package: publint --strict`，根通过 Turbo 调用。
- 不复制参考工程的业务包、历史生命周期记录、发布授权或个人配置。

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
