# IPAB

**InterPlanetary Artifact Bundle**：通过内容标识符（CID）获取、运行和管理应用。

项目愿景是让人与 Agent 跨设备共享、理解和演进 Artifact，详见
[Vision](VISION.md)。下文描述当前已实现的应用运行与内容管理能力。

IPAB 使用 Node 子进程运行 App Bundle，保留应用的命令行参数和标准输入输出，
并提供 IPFS 文件读取与可写输出空间。你可以：

- 通过 CID 运行应用，用具名 pin 保留内容并设置易记的短名。
- 为内容类型关联应用，使用 `ipab open` 打开内容。
- 查看执行历史和输出 CID，按需记录运行日志。

> **安全提示：IPAB 不是沙箱。** 应用拥有当前用户的文件系统、网络和环境权限，
> 只运行你信任的应用。

## 安装

已发布 `0.1.0-rc.2`。支持 Windows、
macOS 和 Linux。安装现有 RC：

```sh
npm install --global @ipab/cli@0.1.0-rc.2
```

使用当前源码：
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

共享 Name 使用 Scope / Variable 服务与独立私网 Kubo。IPAB 按需校验下载安装
Kubo 0.43.2，每个 Swarm 独立受保护 repo、密钥和端口，后台节点随 CLI 退出
仍常驻；设备重启后下次使用恢复，不安装登录自启。服务部署仍由运营者明确完成。
首版仅 LAN／可互访 VPN，无公共中继、内容托管或内容加密。
完整流程和限制见 [Onboarding](docs/onboarding.md)。
首次准备设备运行 `ipab setup --yes`：校验安装共享 Kubo 程序、准备受保护 HOME
身份，重复运行幂等；不接触现有 daemon，不创建 Swarm repo 或登录自启。
独立 CID／具名 pin 的本机操作仍不要求 Kubo。

### 多 swarm 与名称缓存

Owner 创建 Swarm，分享返回的公开配置 URL，并通过可信第二渠道提供 status
显示的 Owner 指纹。成员生成自包含 Request 文件，Owner 人工核对并审批后，
成员下一次正常使用自动取得加密授权包并启动自己的私网节点；没有 Invite、
Response 文件或 Join 步骤。Request 可原样重导出，无自动到期。

```sh
ipab swarm create --name Team --alias work
ipab swarm status work
# 在成员设备上：
ipab swarm request <config-url> --owner-fingerprint <trusted-fingerprint> --alias work --output request.json
# Owner 核对身份后：
ipab swarm approve request.json --yes
# 成员正常使用，自动接入：
ipab swarm list
ipab swarm use work
ipab swarm profile work --name "Wei"
ipab search hello
ipab get --force ipab://work/apps/hello
ipab get ipab:///apps/hello
```

共享名称使用
`ipab://<本机别名或百分号编码的配置URL>/<path>`；URI 中的 swarm 优先，
省略时用 `ipab:///<path>`，按 `--swarm CID或别名`、保存的 `swarm.default`
选择。搜索结果使用稳定配置 URL 的完整 URI，不用本机别名或旧 descriptor CID。
旧 `name:<path>` 已移除；`IPAB_SWARM` 不再支持，需移除该环境变量并改用
`--swarm` 或 `swarm use`。
`get` 省略 `--output`
时解包到独立的系统临时目录，普通 stdout 只输出绝对目录路径；
`--json` 保留 CID 与原始目标信息。临时导出不会在退出时删除，调用方负责清理，
需持久位置时显式指定 `--output`。命令组合见
[获取 Bundle](docs/reference.md#获取-bundle-与命令组合)。
`swarm use` 不需要设置环境变量；`swarm remove work` 只移除本机登记，
不删除证书、内容或远程成员资格。
`swarm update` 只有 Owner 可修改公开组织名称和描述；成员只能改自己的资料。
所有存活 Variable 均公开读，只鉴权写，Owner 证书准确绑定 HEAD／本人资料 ID，
不设过期。HEAD 用内容 CID CAS（允许 ABA），不是历史 revision。
Owner 用 `ipab --swarm work swarm exclude MEMBER_PUBLIC_KEY --yes` 移除成员：
原子 freeze 旧 HEAD 后保留最后确认发布，换 HEAD/key/epoch 与剩余包，同配置 URL
发布，并删除旧 HEAD／离开者资料。中断须 Owner `swarm resume work`，永不解冻。
离线切换窗口、公开元数据及陈旧节点未提交上传风险是明确接受的限制。

`exec`、`open`、`get` 的共享名称解析默认复用 5 分钟内的已验证 swarm HEAD；
有效缓存找不到名称时刷新一次。`--force` 要求立即刷新；`exec` 的该参数必须
放在 App 引用之前，App 引用之后的参数仍全部透传。
`search` 默认按名称关键字检索所有已登记 swarm，缓存有效时只读本地信息，
缺失或过期时更新；`--current` 或显式 swarm 选择可缩小范围。详情见
[swarm 与名称缓存](docs/mvp-implementation.md#swarm-registry-and-header-cache)。

## 快速上手

### 运行应用

将示例中的 `<app-cid>` 替换为你信任且当前 Store 可获取的 App Bundle CID：

```sh
ipab pin add reader <app-cid>
ipab exec reader --help
ipab exec reader
```

`pin add` 只接受完整 Bundle，获取、验证并保留它，同时设置短名和类型信息；
裸文件需先与 `.bundle.yaml` 和其引用的 `.bundle-type.yaml`
包装，独立类型 block 不能 pin。
它不会运行应用或安装依赖。
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

- [MVP 主链路](docs/mvp-user-journey.md)：两台设备按同一个正式名称运行、修改并验证 App
  Bundle（目标场景）。
- [Swarm onboarding](docs/onboarding.md)：文件 Request、加密批准、懒接入、托管私网和可恢复成员移除；
  对应的签名指针服务见 [pointer-worker](packages/pointer-worker)。
- [Scope / Variable 服务](packages/pointer-worker)：Scope 持 Owner，多资源公开读，
  Ed25519 subject 持钥写、内容 CID CAS 与不可逆 freeze/delete。
- [Cloudflare 自安装 Apps](apps/cf-tools)：将 Pointer Worker 构建为内容 Bundle，
  用两个普通 App 本地运行／部署；首次安装锁定的 npm 依赖，支持 `--reinstall`。
- [Scope service API](docs/pointers-service.md)：独立随机 Scope/Variable ID，
  API key 仅创建 Scope、Owner 管理、准确 ID 证书写与 nonce 防重放。
- [命令参考](docs/reference.md)：具名 pin、应用关联、配置、历史与隐私。
- [创建应用](docs/reference.md#app-开发上层-node-profile)：Node / Web
  App 模板与构建。
- [React Bundle Viewer](templates/bundle-viewer)：用一个同构组件封装内容查看器，
  提供真实内容 SSR 与浏览器 hydration。
- [Check Spec 查看器](apps/check-viewer)：查看有序检查定义，长 Instructions
  拆成 Bundle 内的 Markdown 文件；[示例](examples/check-spec)。
- [Check SDK](packages/check-sdk) 与 [Check App 模板](templates/check)：从 STDIN
  校验 JSON、顺序组合 Checkpoints，输出链接原始 Check model 的 Result Bundle。
- [Bundle 工具](docs/reference.md#bundle-开发底层)：构建、检查与导入；
  根 `ipab init` 通过通用 Template Bundle 创建项目或内容。
- [Agent Skill Bundle](docs/reference.md#agent-skill-bundle)：以 Markdown 为入口，
  校验 frontmatter 元数据；[可构建示例](examples/agent-skill)。
- [问题反馈](https://github.com/silvermoon-work/ipab/issues) ·
  [参与贡献](CONTRIBUTING.md) · [设计概览](docs/design-overview.md)
- [验证分层](CONTRIBUTING.md#ci-与交付)：日常 `pnpm check`／`pnpm check-ci`
  只跑 unit/mock；发布前只读 `pnpm check-release`
  保留完整测试、覆盖率与安装验证。

## 许可证

[MIT](LICENSE)
