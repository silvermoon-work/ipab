# Contributing

使用 `.node-version` 指定的 Node 和根 `packageManager` 指定的 pnpm：

```sh
pnpm install
pnpm check
```

根 check 依次执行格式、构建、类型、全仓库 lint、成员覆盖率和交付包检查。
不能通过排除源码、删除测试、放宽门槛或吞掉错误来取得通过结果。
当前 `apps/ipab` 是 private code package，包含真实 CLI、子进程和 writable
Store 回归测试；根不另建独立测试套件。没有 npm 交付项，包发布检查无任务。

## Workspace

- 可执行应用放在 `apps/`，公共代码放在 `packages/`。
- 共享第三方依赖放在 pnpm catalog，内部依赖使用 `workspace:*`。
- 根包保持 private，不发布整个 workspace。
- TypeScript 源码和测试保持 strict，并由 type-aware ESLint 检查。
- 每个 code package 扩展根 TypeScript 配置，并独立声明 build/typecheck。
- 测试用共享 `vitest.config.ts`，在成员目录显式指定
  `--root . --config ../../vitest.config.ts`。
- `pnpm test` 为单轮非 coverage 测试，`pnpm test-coverage` 执行覆盖率。
- 全部四项全局覆盖率门槛为 90%，包含未测试源码，不使用 `passWithNoTests`
  隐藏缺失测试。
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

所有 PR 和 main push 执行冻结安装与根 check，默认 job 和兼容矩阵必须全部成功。
`Release verification (v1)` 目前仅汇总这些检查，不批准或执行 npm 发布。
本脚手架没有发布 workflow、npm 交付项或部署操作。

迁入真实 npm 包时再登记包内 `deliverable.yaml`，补齐源码链接、exports、
delivery allowlist、许可证、source/declaration maps 和 `publint --strict`。
发布只使用授权的准确包／版本／提交及 Trusted Publishing，
保留成功的准确 SHA main CI 门槛，不保存 npm token 或复制个人 registry 配置。

代理先读 [AGENTS.md](AGENTS.md) 和 [项目指导](docs/agent-project.md)。
