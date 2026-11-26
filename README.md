# IPAB

**InterPlanetary Application
Bundle**：通过内容标识符（CID）获取、运行和管理应用。

IPAB 使用 Node 子进程运行 App Bundle，保留应用的命令行参数和标准输入输出，
并提供 IPFS 文件读取与可写输出空间。你可以：

- 通过 CID 运行应用，用具名 pin 保留内容并设置易记的短名。
- 为内容类型关联应用，使用 `ipab open` 打开内容。
- 查看执行历史和输出 CID，按需记录运行日志。

> **安全提示：IPAB 不是沙箱。** 应用拥有当前用户的文件系统、网络和环境权限，
> 只运行你信任的应用。

## 安装

目前尚未发布 npm 包，需要从源码安装；支持 Windows、macOS 和 Linux。
请先安装 Git、[指定版本的 Node](.node-version) 和
[packageManager 指定版本的 pnpm](package.json)，然后执行：

```sh
git clone https://github.com/silvermoon-work/ipab.git
cd ipab
pnpm install
pnpm link-cli
ipab --version
```

`pnpm link-cli` 会构建并链接本地命令，不发布 npm 包。
如果提示全局 bin 目录未配置，先执行 `pnpm setup`，重启终端后重试。

始终使用本地内容 Store，**无需安装 Kubo**。可选择一个上游 HTTP Gateway
获取本地缺失的内容，例如局域网存储节点提供的 Kubo Gateway：

```sh
ipab config set store.gateway http://127.0.0.1:8080
```

这里填写的是 Gateway 地址，不是 RPC API。获取的 block 校验后缓存到本地；
写入、pin、空间统计和 GC 都留在本地，不上传或控制上游节点。
不配置 Gateway 时仅使用本地内容。

旧 `store.rpc` 已移除：先执行 `ipab config reset store.rpc`，再设置 Gateway。
旧 Kubo pin／历史保留记录不会自动迁移或解除；需重新获取并建立本地 pin，
旧节点上的 pin 由你独立管理。

## 快速上手

### 运行应用

将示例中的 `<app-cid>` 替换为你信任且当前 Store 可获取的 App Bundle CID：

```sh
ipab pin add reader <app-cid>
ipab exec reader --help
ipab exec reader
```

`pin add` 获取、验证并保留内容，同时设置短名；它不会运行应用或安装依赖。
`exec` 也可以直接接受 App CID，应用名之后的参数会原样传给应用。

如果拿到的是本地 CAR 文件，先导入，再用返回的 CID 执行上述步骤：

```sh
ipab bundle import ./app.car
```

导入不等于持久保留；需要保留内容时使用 `pin add`。

### 打开内容

应用声明支持某个内容类型后，可以保存类型与应用的关联：

```sh
ipab register set <schema-cid> reader
ipab open <content-cid>
```

默认把内容 CID 作为一个参数传给应用；应用需要其他参数时，参见
[关联与参数模板](docs/reference.md#本机命令与上游-gateway)。
IPAB 不会自动选择应用；关联的类型必须与应用声明支持的准确类型 CID 匹配。

### 管理内容与历史

```sh
ipab pin list
ipab store usage
ipab store gc
ipab history list
ipab history show <run-id>
ipab exec --log reader
ipab --help
```

`store usage` 显示本地缓存 block 字节与所有递归 pin 的去重 block 字节；
`store gc` 显式清理整个当前本地 Store 中未受保护的 block，保留 pin、
所有参与者引用及未完成操作／导入。不会自动 GC，也不会请求 Kubo daemon GC。

历史默认保存实际命令行参数，但不记录标准输入输出。
参数中不要传入秘密；必要时通过 `ipab config set history.enabled false`
关闭历史。
`--log` 需开启历史，且可能记录敏感输出，仅在需要调试时使用。

## 更多文档

- [命令参考](docs/reference.md)：具名 pin、应用关联、配置、历史与隐私。
- [创建应用](docs/reference.md#app-开发上层-node-profile)：Node / Web
  App 模板与构建。
- [React Bundle Viewer](templates/bundle-viewer)：用一个同构组件封装内容查看器，
  提供真实内容 SSR 与浏览器 hydration。
- [Check Spec 查看器](apps/check-viewer)：查看有序检查定义，长 Instructions
  拆成 Bundle 内的 Markdown 文件；[示例](examples/check-spec)。
- [Bundle 工具](docs/reference.md#bundle-开发底层)：初始化、构建、检查与导入。
- [Agent Skill Bundle](docs/reference.md#agent-skill-bundle)：以 Markdown 为入口，
  校验 frontmatter 元数据；[可构建示例](examples/agent-skill)。
- [问题反馈](https://github.com/silvermoon-work/ipab/issues) ·
  [参与贡献](CONTRIBUTING.md) · [设计概览](docs/design-overview.md)
- [验证分层](CONTRIBUTING.md#ci-与交付)：日常 `pnpm check-ci`、全量
  `pnpm check` 与发布前只读 `pnpm check-release`。

## 许可证

[MIT](LICENSE)
