# MVP 主链路：跨设备运行并迭代一个 App Bundle

**状态：用户链路已确认；具体实现、命令与迁移见
[MVP 实现决策](mvp-implementation.md)。下文保留产品需求背景。**

本场景落实[项目愿景](../VISION.md)：一个用户、一个个人 swarm、设备 A 与 B，
以及各自的 Agent。用户在 A 创建并命名一个小程序，在 B 按名字运行和修改，
再回到 A 验证修改后的结果。FBO 是语音识别误差，本场景的内容就是 App Bundle。

## 核心引用

MVP 必须完整贯通 **Name → CID
→ 内容**，不能用直接交换 CID 或复制项目目录代替按名运行。
此前的三层 AID 映射已由用户确认的 Bundle 版本链模型取代，不再引入 AID。

- Name 是命名域内正式路径，不是自然语言别名。Agent 理解用户的话并消歧到路径。
- Name 是本场景中不随发布变化的入口。
- CID 标识普通 Bundle 或 Artifact Bundle；运行时固定解析得到的 App Bundle CID。

Artifact 是一种特殊 Bundle 类型，entry 为
`{ value: cid, previous?: cid, timestamp }`：
value 引用本次内容 Bundle，previous 为可选的单个前次 Artifact Bundle CID。
版本链内所有节点使用同一种类型，首版省略 previous，不把普通内容当作链尾。
版本节点与其内容 Bundle 自身均使用 CID。
时间字段的编码待定，不替代共享 HEAD 的 CAS，也不作为并发胜负的依据。

例如 `apps/hello` 首次指向 Artifact Bundle `C0`，
其中 `value: B0` 是原版 App，省略 previous。
修改后指向 `C1`，其中 `value: B1` 是新 App，`previous: C0` 链接原版发布。
再次发布可生成 `C2`，其中 `value: B2`、`previous: C1`。
普通 Bundle 仍可被直接命名，但本 MVP 的迭代发布使用统一版本链。
这些路径和 CID 占位符只用于说明，不规定命名语法。

## 版本解析与内容展开

运行、下载和 open 均需理解 Artifact 版本链：默认选择版本节点 value 指向的内容，
普通 Bundle 则直接使用。一次操作固定所选发布和内容 CID，不在过程中切换版本。

- exec 校验并执行所选 App，不提供 raw 模式。
- 下载是通用 Bundle 内容展开，不是专门的源码操作；支持 raw 选择版本节点本身。
- 下载子命令的命名已确认为 get，与 Kubo 的 ipfs get 对齐；具体接口仍待设计。
- open 支持 raw，按版本节点自身类型寻找适用 App，而不是按 value 的类型。
- raw 不自动遍历历史，也不自动获取源码；具体参数语法待 CLI 设计。

当前 App 构建默认生成独立源码 Bundle，App 通过 source CID 弱关联源码。
目标流程将应用编译与专用前置处理移至项目工具，源码生成也需由该流程明确安排，
不能假定泛化后的 IPAB build 自动产出源码包。
Agent 可以读取该约定，再用通用下载操作展开源码。没有源码不使 App 下载失败，
但会让后续编辑更困难；是否尝试修改编译或 minify 后的脚本由 Agent 判断。
本 MVP 正常链路仍要求提供源码，避免把这种困难路径当作默认开发体验。

## 应用准备与通用打包的边界

目标 IPAB build 对任意 Bundle 做最终组装、校验和 CAR 打包，不自动编译 App、
执行 npm scripts 或调用 prebuild hooks。App 的编译、app.json 生成、
supportedSchemas CAR 等专用资源准备放在项目脚本或独立 dev tool 中，
不为这些处理新增 IPAB CLI 专用分支，也不要求现在新建 dev tool 项目。

打包描述明确类型、entry、本地文件选择与包内位置，以及显式 CID 导入。
它是构建配方，不是交付后的类型定义。当前 Bundle 自身的类型编码、入口与路径校验
仍属于通用打包机制；App 支持其他类型的资源生成属于前置工具。
CID 导入的具体表示、描述文件名和格式仍待讨论。

目标流程为项目工具显式准备产物 → IPAB build 打包 → 本地验证 → IPAB publish。
这是对当前根 build 编译 App 行为的有意调整，尚未实现。
模板、项目脚本、源码交接与旧命令兼容需要一致迁移，不能只改 CLI 名称。

## 阶段零：准备设备与 IPFS 私网

MVP 从内容网络准备开始：A、B 均已安装 IPAB 和 Kubo（IPFS 节点），
由用户配置加入同一 IPFS 私网，并确认节点互相可达。
私网接入凭据通过已有的安全渠道配置，不能依赖尚未加入的网络来取得。
具体安装、私网配置和节点发现属于前置准备，不预设新的 IPAB 子命令。

先在 A 向私网提供一份小内容，将 CID 告诉 B，确认 B 能获取并校验完整内容；
再反向验证 B 到 A。只有 CID 而没有可达的内容提供者，不算准备完成。

**IPFS 私网接入与 IPAB swarm 授权是两道不同的边界。**
完成此阶段的 B 可以通过 CID 交换内容，但还不能读取或更新 IPAB swarm 的 HEAD。
因此后续授权请求和响应可以在私网内交换，不会出现“先成为 member 才能申请加入”的循环。

当前 IPAB Store 是本地存储加可选只读 Gateway。配置指向私网 Kubo 的 Gateway，
可以读取该节点可获取的内容，但不把 IPAB 本地写入自动发布给 Kubo。
MVP 必须明确将 Bundle blocks 导入并保留于可达的私网内容提供者的步骤，
随后验证对端可获取；具体桥接命令待设计。安装 Kubo 不意味着恢复旧 `store.rpc`。

## 阶段一：建立 swarm 并授权两台设备

此阶段从用户尚未拥有 swarm 开始，不能要求其事先准备一个现成的 swarm 标识。
预期的首次使用过程如下，具体子命令和凭据保管方式待设计：

1. 用户选定一个可用的中心服务。MVP 可使用已部署的服务；
   是否由 IPAB 提供默认服务、是否支持自行部署，尚未确认。
   创建时由服务引导用户完成本次授权，IPAB 只在本次操作中使用临时服务凭据，
   不保存服务登录状态，也不静默复用上一次授权。
   此服务授权不同于 owner 根身份或 member 身份；无人值守且无法完成授权时明确停止。
2. 用户在受控的本地环境初始化当前 OS 账号身份，密钥保存在账号 HOME 中。
   已有账号身份直接复用，不因创建 swarm、切换项目或状态目录生成另一身份。
   用户以该身份创建 swarm，
   保管私钥并取得 Swarm Bundle 的 CID，作为该 swarm 的标识。
   该公钥成为此 swarm 的 owner 根公钥；
   创建过程只向服务提交公钥和持钥证明，
   注册初始 HEAD；不能把根私钥复制给远端服务或写进对话、日志。
   创建成功只返回 Swarm Bundle CID；JSON 模式只含 cid。
   服务地址、变量与公钥在描述 Bundle 中，HEAD 和指纹不重复作为主要返回结果。
   创建者已具备该 swarm 的 HEAD 读写能力，服务直接按登记的 owner 公钥验证请求，
   不需要 A 再给自己申请和签发成员证书。
3. 用户向待加入的 member 提供 Swarm Bundle CID。
   该公开描述 Bundle 包含服务 URL、服务端变量标识及 owner 根公钥，
   分别使用 service、variable、owner 字段，owner 是完整公钥，不是其指纹。
   member 通过私网按 CID 获取，不需要另行拼接接入信息。
   B 上的 IPAB 自动复用该 OS 账号 HOME 中的身份，
   首次尚无身份时自动初始化，不为每次申请强制生成新密钥，
   构建带有明确类型的授权请求 Bundle，包含目标 swarm、成员公钥及请求标识。
   请求通过成员签名证明持有该公钥对应的私钥；私钥不入包。
4. member 将请求 Bundle 提供给私网，向 owner 交付请求 CID。
   owner 按 CID 获取并校验请求，审视目标 swarm 和成员身份，
   确认后以根私钥签发证书，再构建授权响应 Bundle。
   响应引用准确的请求 CID，并包含签发证书；owner 将响应提供给私网，
   向 member 交付响应 CID。
5. member 按响应 CID 获取并校验 Bundle，验证证书由可信的目标 swarm 根签发，
   核对其绑定的成员公钥与自己的本地密钥一致、响应对应自己的请求，
   然后保存证书及服务绑定。只转移请求、响应和各自 CID，不转移私钥。
6. A 以 owner 身份、B 以 member 身份读取同一个 HEAD，验证接入成功，
   再进入创建小程序的阶段。

角色统一称为 owner 和 member：创建者是 owner，只有 owner 能授权新 member。
member 指 swarm 成员，不等同于设备；A、B 只是本场景的两台设备。
成员身份如何在设备上配置与使用，不改变这一角色边界。
身份是每个 OS 账号 HOME 中的单一持久密钥对，MVP 不提供账号内多身份切换。
同一账号下的 Agent、项目和 swarm 自动复用它，改变 state-dir 或 worktree 不改变身份。
owner 和 member 是该身份相对于某个 swarm 的角色。
同一身份可以创建一个 swarm 成为 owner，又申请加入另一个 swarm 成为 member，
成员证书按 swarm 限定资格，不创造新身份。需要独立身份时可使用不同 OS 账号，
不要求 owner 和 member 使用不同密钥。
身份 key 仅允许所属账号访问，Unix 使用文件权限，Windows 使用 ACL。
若 Agent 能自由使用 owner 私钥，也具备相应签发能力，角色标签不能限制该密钥。
owner 无需 member 证书即可读写自己创建的 swarm；
member 仍须证书验证，统一账号密钥不意味着拥有所有 swarm 的权限。

用户创建 swarm，保管身份私钥，授权在两台设备上使用的 member 身份。
两台设备知道中心服务位置和内容获取方式；
日常操作自动使用账号身份及对应 swarm 的成员证书。

具体成员认证与共享 HEAD 的要求见[创建与授权需求](swarm-authorization.md)。
中心服务每个 swarm 仅维护一个 HEAD，不为每个 Name 建立独立变量。
HEAD 引用发布记录与 Merkle DAG 状态；其中保存 Name → CID 映射。
可变的 properties（例如 swarm 名称和描述）也保存在共享 State 中，
不通过改写 Swarm Bundle 来更新。Swarm Bundle CID 是固定接入入口，
HEAD CID 是变化的状态，不作为用户的 swarm 标识。
properties 的具体字段、编辑接口和字段级冲突规则待设计。
共享状态的发布历史与单个内容的 Artifact 版本链是不同层次。
Name 的具体存储结构仍待设计。

## 阶段二：A 创建、命名并发布 v1

用户让 Agent A 创建一个小程序。Agent 完成项目初始化，用户或 Agent 编辑源码，
随后由项目工具编译和准备 App 产物，再由通用 IPAB build 生成 App
Bundle，在 A 验证结果，
构建 value 指向 App 的首版 Artifact Bundle（没有 previous），
为小程序建立 Name → Artifact Bundle CID 的映射并发布初始版本。

除了可执行 App Bundle，还必须让 B 获取对应的可编辑源码及必要构建材料。
源码不能只存在于 A 的目录中。依赖安装和构建环境准备可以由外部开发工具完成，
不把“能获取源码”当成“任意机器天然能离线构建”。

示例行为：固定输入 `Alice`，v1 输出 `Hello Alice`。
具体小程序的业务形式待定，但结果必须能明确验证。

## 阶段三：B 仅按 Name 运行 v1

用户让 Agent B 按相同 Name 运行小程序，不发送 CID，不复制 A 的项目目录，
也不在 B 手工重建本地具名 pin。

Agent B 读取共享 HEAD，沿 Name → CID 获取并校验 Bundle；
若 Name 指向 Artifact Bundle，则沿 value 解析本次内容并确定 App Bundle，
在获准执行可信 App 后运行。示例输入应得到与 A 相同的 v1 结果。
成员资格并不自动等于执行任意 App 的授权。

## 阶段四：B 修改、验证并发布 v2

此阶段有两个独立的 IPAB 操作：下载内容与提交修改。
Agent B 先按 Name 下载并展开 App Bundle，取得 Name 实际指向的发布节点 CID；
共享 HEAD 作为 IPAB 内部同步状态维护，不作为用户必须传入的编辑基线。
然后按 App 的源码关联，用相同下载能力取得 v1 源码。
下载只负责解析、校验、展开与返回版本信息，不安装依赖、不执行或修改代码，
也不自动开始提交，不静默覆盖已有文件。

中间的修改完全由 Agent 在本地文件系统完成，使用项目工具编译和准备产物，
再用 IPAB build 打包并验证 v2。例如让同一输入的输出变为 `Welcome Alice`。
本地编辑和构建不自动改变已发布版本。

用户确认发布后，Agent 提供新的 App Bundle 及对应源码，
构建 value 指向新 App、previous 指向编辑基线发布节点的 Artifact Bundle。
用户提交新包时给出 Name 及预期的旧发布节点 CID，而不是 value 指向的 App CID。
IPAB 检查目标 Name 仍指向该节点，随后使用内部同步的 HEAD 做原子 CAS。
如果其他 Name 的更新造成全局 CAS 竞争，IPAB 自行刷新状态，复核目标 Name 的基线，
保留其他 Name 的更新并重建候选状态，再次提交，不把这类竞争当成编辑冲突拒绝修改。
如果目标 Name 已偏离预期节点，则保留候选成果并报告编辑冲突，不能替用户换基线。

提交操作接收已构建的成果，不重新下载源码、编辑文件或执行构建。
previous 必须对应实际编辑基线，不能在提交时悄悄替换成当前最新发布。

源码与 App 的关联方式、构建材料交接形式、发布接口均待 CLI 与协议设计确定。
现有 App 源码弱关联不是自动保留或跨设备分发的保证。

## 阶段五：A 按原 Name 验证 v2

用户回到 A，仍按原 Name 运行，不手工替换本地 pin，不把新 CID 传给 A。
Agent A 刷新共享状态，按原 Name 取得 Artifact Bundle，解析 value，
固定并运行新的 App Bundle CID，验证修改后的结果，
不能因旧缓存仍运行 v1 却宣称已取得当前版本。

明确指定旧 App Bundle
CID 或沿 previous 查询旧发布时应仍可验证旧行为；本次验收须保留其所需块，
不能假定所有旧内容天然永久可用。

## 验收与失败边界

- 两台设备使用各自账号身份，分别证明 owner 或 member 资格；未授权访问者不能读写共享 HEAD。
- A、B 已在同一 IPFS 私网内双向按 CID 获取内容。
  尚未获准访问 HEAD 的 member 可获取授权响应，且必须验证证书才能完成加入。
- B 仅凭 Name 即可解析、获取和运行 v1，源码交接不依赖 A 的本地项目目录。
- B 发布后 Name 不变，指向新的 Artifact Bundle CID，App CID 改变；
  A 按原 Name 解析 value 并运行 v2。
- 示例输入的两个版本输出不同且可断言，实际运行的 CID 可核对。
- 同一旧 HEAD 的单轮 CAS 最多一个成功；不同 Name 的竞争由 IPAB 内部整合重试，
  在目标 Name 未改变时两次修改均应可发布。
- 同一 Name 基于同一旧节点的竞争更新最多一个成功，另一方得到编辑冲突，
  不能丢弃其未发布成果。
- 内容不可获取、构建失败、执行未获授权、身份验证失败或中心服务不可用时，
  明确指出失败阶段，不以旧内容或仅登记根指针冒充成功。
- HEAD 已提交与内容已能跨设备获取分开呈现，未完成内容分发不能报告共享完成。

## 下一步：逐步展开 CLI

按建立身份与入群、创建与构建、命名与发布、按名运行、
取得源码与修改、发布迭代的顺序讨论。既有命令仅作证据，
新增命令及行为修改需单独确认，不在本链路文档里预先定案。

第一版不包含团队角色、跨 swarm、自动合并、完整 Agent 记忆同步或任意 Skill 执行。
示例业务、具体命令、参数与输出契约尚未确认。
