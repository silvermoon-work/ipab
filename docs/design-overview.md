# IPAB Design Overview

本文记录 2026-11-23 讨论形成的设计方向，作为 IPAB 后续协议和产品设计的起点。
它不是已经完成的 CLI Spec，也不代表文中的示意接口已在本仓库实现。

## 1. 定位与当前状态

IPAB 是 InterPlanetary Application Bundle：以不可变内容包为输入、
通过应用包处理内容的通用启动器。

最初讨论源于 ipfsaw 的渲染对象改造，后来扩展为统一的“打开内容包”模型：
查看文档和执行任务可以由不同 App 实现，不必在宿主中分别维护 Viewer
和 Executor 两套业务概念。希望由这一模型统一类似 ipfsaw、ipfspawn 的入口能力，
而不是简单拼接两套 CLI。

已确认的方向：

- 在 `silvermoon-work/ipab` 新仓库独立开发，不直接把原仓库的 ipfsaw 改名。
- 内容包与应用包分离，分别使用 CID 标识。
- App 尽量作为现有 Task Bundle 的约定 profile，复用 Task 基础设施。
- App 的业务输入只有一个 Content Bundle 根 CID。
- 用 `open` 表达打开内容，用 `apps` 表达默认应用管理。
- 仿照操作系统 Default Apps，直接关联 Schema CID 和默认 App CID，
  不再同时维护 alias 注册和 binding 两层模型。

当前本仓库只有工程脚手架，尚未迁入包或实现上述能力。
公共 `@silvermoon-work/content-bundle@0.1.0-rc.0` 已在原仓库完成首个功能 RC
发布；将它迁入本仓库是后续工作，本轮没有迁移。

此前为 ipfsaw 生成的 view/watch/viewer CLI 草案未获最终批准。
它只可作为需求讨论的历史参考，不能当作 IPAB 的有效命令规范。

## 2. 为什么从文件变成 bundle

依赖业务 JSON 内的 `$schema` 或显式 Viewer 参数来识别渲染对象，存在局限：

1. JSONL 整体没有可以承载顶层 `$schema` 的单一对象。
2. JSON/YAML 即使不带 `$schema` 也可以是合法业务数据；
   为了工具识别而修改数据具有侵入性。
3. 一个文件无法完整表达入口数据、附件、图片及关联内容组成的对象。

因此，把被处理对象定义为一个 UnixFS 目录 bundle：
业务数据保持原样，类型信息放入独立 manifest，资源与数据共同形成内容快照。

本地 folder、zip、tar、单根 CAR 和 CID 是不同的输入或分发载体，
不是不同的内容协议。它们最终需要得到满足协议的 UnixFS 目录根 CID。
仅有“单根 CAR”并不够，根还必须是符合要求的目录。
具体归档格式范围、导入参数及包装目录规则需要在来源适配设计中确定。

## 3. 三类对象及其关系

| 对象               | 标识               | 职责                               |
| ------------------ | ------------------ | ---------------------------------- |
| Content Bundle     | UnixFS 目录根 CID  | 被打开的数据及其配套资源           |
| JSON Schema        | DAG-CBOR block CID | 约束结构化数据，识别准确的数据契约 |
| Application Bundle | App 根 CID         | 接收内容根 CID，展示或处理内容     |

```text
Content Bundle
  .bundle.yaml
    entry.path ────────> 结构化数据文件
    entry.schemaCid ──> DAG-CBOR JSON Schema

Schema CID ── 用户默认应用关联 ──> App CID

宿主启动 App
  唯一业务输入：Content Bundle 根 CID
```

Schema 标识数据契约，不指定唯一 UI 或执行程序。
同一份契约可以有多个处理应用；用户选择其中一个作为默认。
CID 只证明内容身份，不证明程序可信、数据业务正确或执行已经得到授权。

## 4. Content Bundle 协议

### 4.1 唯一的描述文件

每个 bundle 根目录必须存在准确命名的 `.bundle.yaml` 普通文件：

- 文件名大小写严格匹配。
- UTF-8、单文档 YAML。
- 不搜索 `.bundle.yml` 或 `.bundle.json`。
- 不拒绝 YAML 中合法的 JSON 风格语法。

manifest 只描述入口：

```yaml
entry:
  path: data/events.jsonl
  schemaCid: "<Schema CID>"
  contentType: application/jsonl
```

三个字段都必需：

- `path`：相对于当前 bundle 根的文件路径。
- `schemaCid`：该文件解码结果对应的 JSON Schema CID。
- `contentType`：决定数据如何解码，不从扩展名或数据内部 `$schema` 猜测。

### 4.2 结构化数据格式

支持的 ContentType：

| ContentType         | 解码结果                   |
| ------------------- | -------------------------- |
| `application/json`  | 一个 JSON-compatible 值    |
| `application/yaml`  | 一个 JSON-compatible 值    |
| `application/jsonl` | 按文件行顺序解析得到的数组 |

JSONL 保留记录顺序和重复值，不添加 `{records: [...]}` 包装。
其 Schema 必须显式声明根 `type: array`，校验完整数组而非只校验单条记录。
空文件对应 `[]`，能否通过由 Schema 决定；坏行和内部空行明确报错，不跳过。

业务 JSON/YAML 可以是对象、数组或其他合法 JSON 值，不要求携带 `$schema`。
公共库当前采用有界解析，拒绝重复 YAML 字段、多文档、未知标签、
非有限数、循环 aliases 和超限展开。具体实现限制不是 CLI 用户必须配置的业务参数。

### 4.3 内容引用扩展

在 JSON Schema 中，使用 `type: string` 和布尔扩展 `x-content-ref`
标注需要作为内容引用处理的字段：

```json
{
  "type": "object",
  "properties": {
    "details": {
      "type": "string",
      "x-content-ref": true
    }
  }
}
```

引用字符串有四种格式：

```text
yaml:{schemaCid}:{relative-path}
json:{schemaCid}:{relative-path}
jsonl:{schemaCid}:{relative-path}
bundle:{relative-path}
```

前三种相当于内联的入口描述：格式、Schema CID 和路径共同确定目标数据。
`bundle:` 指向子 bundle 目录，由子目录的 `.bundle.yaml` 决定入口和契约。

路径始终相对于当前 bundle 根，而不是包含引用的数据文件所在目录。
进入子 bundle 后，子目录成为新的路径基准，不能通过 `..` 访问父 bundle。
路径使用 `/`，拒绝绝对路径、穿越、反斜杠、编码路径及其他歧义形式。

只有 Schema 标注的字段才作为引用处理，普通字符串即使外观相同也不触发读取。
`x-content-ref` 不只是展示注解：验证时必须跟随引用，解析并校验目标。

以下情况全部失败：

- 引用格式无效或路径不安全。
- 文件、子 bundle 或其 manifest 无法访问。
- 对应 Schema 无法取得或无效。
- 内容不符合 Schema。
- 递归验证超过资源限制。

允许引用形成环，通过去重和有界遍历处理，不无限递归。
Schema 的 `$ref` 引用 Schema；`x-content-ref` 字段中的值引用数据，
两者不能混淆。

## 5. JSON Schema 的存储和外部引用

### 5.1 确定性 DAG-CBOR

Schema 先解析为 JSON Schema 值，再编码为一个确定性 DAG-CBOR block，
使用 CIDv1、`dag-cbor` codec 和 SHA-256 生成 CID。
不把 CBOR bytes 包装成 UnixFS 文件后再使用文件 CID。

```text
Schema 源文本
→ Schema 值
→ 确定性 DAG-CBOR bytes
→ Schema CID
```

这样空白、缩进和对象字段顺序不影响 CID。
字段值、描述文字及数组顺序改变仍会改变 CID；
不归并语义等价 Schema，不删掉注解，也不把 CID 当作语义版本号。

### 5.2 `$ref` 规则

`$ref` 在 JSON Schema 标准中是 URI-reference，不要求一定为绝对 URL。
本协议进一步限制：

- 允许当前 Schema 内部的 `#/$defs/item` 等引用。
- 外部引用必须使用 `ipfs://<CID>`，可带目标子 Schema 的 fragment。
- 禁止 HTTP/HTTPS、文件路径或裸 CID 作为外部 `$ref`。
- 每个外部 Schema 同样必须按本协议编码并存入 IPFS 内容存储。

```json
{
  "$ref": "ipfs://<Schema CID>#/$defs/item"
}
```

外部 Schema 的取得、标准化编码和导入由上层或作者工具完成。
`openBundle` 通过 resolver 读取已经按 CID 标识的 blocks，
不隐式把任意 HTTP Schema 下载、转换或上传。

现有公共库使用 JSON Schema 2020-12，并允许本地 anchor。
它明确限制 `$id`、动态引用、异步 Schema 及部分 applicator 形式；
这些是当前实现 profile，不代表已实现完整 JSON Schema 全部能力。
迁移时应保留相应错误语义，并单独讨论扩展，不能静默跳过不支持的引用。

### 5.3 离线闭包不是自动得到的

manifest 的 `schemaCid`、Schema 的 `$ref` 和内容引用都是字符串，
不会因为使用了 DAG-CBOR 就自动变成 IPLD 链接。

因此：

- 内容目录的 UnixFS DAG 不天然包含外部 Schema。
- 导出该根的 CAR 不天然收集所有 Schema 依赖。
- 仅递归 pin 内容根，不保证所有 Schema 和 App 依赖被保留。

离线交付、依赖收集和保留机制需要显式处理这些依赖。
不能把标准 `$ref` 字符串改成 CID 对象来伪造链接，否则会破坏 Schema 语义。

## 6. 公共 content-bundle 包的边界

核心函数是 `openBundle`。输入必须是固定的 UnixFS 目录根 CID，
而不是可变目录或归档路径。

```ts
openBundle(rootCid: CID, options: OpenBundleOptions): Promise<ContentBundle>
```

options 必须提供如何根据 CID 取得原始 block：

```ts
interface OpenBundleOptions {
  resolveCid(cid: CID, options: { signal?: AbortSignal }): Promise<Uint8Array>;
  signal?: AbortSignal;
  limits?: Partial<BundleLimits>;
}
```

resolver 适用于 UnixFS 和 Schema，不只返回已解析的 Schema。
调用者决定存储、网络和缓存来源；公共包负责 CID 核验、codec 解码和验证。

返回前，`openBundle` 完成 manifest、入口数据、Schema 依赖、
content refs 和可达子 bundle 的验证。必要内容缺失或验证未完成时，
不能返回成功对象。未声明 Schema 的附件检查路径及存储完整性，
不凭空赋予业务数据契约。

返回对象保持小而明确：

```ts
interface ContentBundle {
  readonly cid: CID;
  readonly manifest: BundleManifest;
  readFile(
    path: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadableStream<Uint8Array>>;
}
```

- `readFile` 返回原始文件 stream，不根据格式改变返回类型。
- entry 就是 manifest 的一部分，不另设 `readEntry`。
- 图遍历是校验内部机制，不暴露 `resolve` 或独立验证方法。
- bundle 不拥有长期 Store，不要求调用者对 bundle 调用 `close`。
- 单次 stream 的正常结束、取消和错误负责释放该次读取资源。

运行时 exports：

```ts
export {
  openBundle,
  parseBundleManifest,
  parseContentRef,
  encodeSchema,
  ContentBundleError,
};
```

类型 exports：
`ContentBundle`、`OpenBundleOptions`、`BundleLimits`、`BundleManifest`、
`ContentType`、`ContentRef`、`JsonSchema`、`SchemaBlock`、
`ContentBundleErrorCode`。

公共包不负责 snapshot 导入、文件监听、应用匹配、浏览器宿主、
Task 执行、Store 配置、pin 或发布。

文件 stream 避免读取大附件时整体驻留内存，
但通用 JSON Schema 校验仍需要有界解析和全局状态。
stream API 不等于能验证任意大 JSON/YAML 或无限 JSONL 日志。

## 7. Application Bundle 与打开方式

### 7.1 App 是内容处理程序

App 的业务输入只有一个 Content Bundle 根 CID。
优先把它定义为现有 Task Bundle 的 profile，而不是创建第二套执行引擎。

```text
用户选择内容来源
→ 归一到 Content Bundle 根 CID
→ openBundle 校验
→ 识别 entry.schemaCid
→ 选择用户信任的 App CID
→ 启动 App，传入内容根 CID
```

“输入只有 CID”指业务参数，不意味着执行上下文也只有一个字符串。
宿主仍需提供取消、生命周期、运行时资源和受控内容访问能力。
CID 如何落在现有 Task 参数契约中，以及 Node/browser runtime 的具体约束，
需要 App profile 单独定稿。

### 7.2 Default Apps 模型

| 操作系统概念 | IPAB                             |
| ------------ | -------------------------------- |
| 文件类型     | entry 的 Schema CID              |
| 默认应用     | App CID                          |
| Open With    | 本次显式指定 App，不修改默认关联 |

只维护直接的 `Schema CID → App CID` 关联。
ContentType 只用于解码，不用于决定默认应用。
不再引入 alias 注册表加 binding 表的间接命名链。

配置关联和执行应用是不同操作：
保存默认关联不证明应用兼容，不应该执行 JavaScript 来探测它。
找不到默认 App 时应明确提示用户选择，不自动安装并执行未知程序。

`open` 和 `apps` 是已确认的命名方向，但子命令、flags、配置格式、
输出形状和替换行为尚未完成确认，不把早期 viewer 命令树机械重命名为最终接口。

### 7.3 Task Invocation 也可以是内容

一个包装 bundle 可以同时包含 Task Bundle 和输入数据。
它的入口遵循独立的 Task Invocation Schema，
由处理这种 Schema 的 App 使用 Task Engine 执行任务。

```text
调用内容包/
  .bundle.yaml
  invocation.json
  input.json
  task/
    task.yaml
    ...
```

这里描述的是组合方式，不是已确定的字段协议。
如何定位 Task、如何引用输入、如何收集执行依赖及呈现结果仍需设计。
不能仅把任意 Task 子目录标成 `bundle:` 就宣称它符合 Content Bundle 协议；
`bundle:` 的目标必须有自己的 `.bundle.yaml`。

公共内容校验不替代 Task 契约校验：
Task 的完整性、runtime、参数契约、权限和执行结果由 Task 层处理。
希望复用 ipfspawn 背后的执行能力，不要求通过 ipfspawn CLI 子进程完成组合。

## 8. 快照、变化与内容后端

### 8.1 公共包只面对不可变快照

```text
folder / zip / tar / CAR
→ 来源适配层取得或生成目录快照 CID
→ openBundle(CID)
→ 读取同一内容身份下的文件
```

本地内容变化后，由上层观察并生成新的根 CID，再消费新的 bundle。
公共包不监听文件系统，也不让同一个 bundle 对象换到新内容。

固定 CID 保证内容身份，不保证 blocks 永远可用。
后续缺失或损坏必须报错，不能返回另一个版本作为替代。

### 8.2 读写能力与 Kubo RPC

后端参数应该表达内容后端配置，不能仅给一个 gateway。

| 用途                   | 能力要求                                  |
| ---------------------- | ----------------------------------------- |
| 打开已有 CID/CAR       | 按 CID 读取，并在使用期间保持来源可用     |
| 根据本地文件生成新快照 | 写入 blocks，保护构建中及活跃内容不被回收 |

可复用已有 local Store 或 Kubo daemon。
Kubo 使用标准 HTTP RPC API `/api/v0`，不另造自定义 IPC 协议。
gateway 可以是受控只读来源，但不能代替写入和保留机制。
已有 CAR 可以直接提供 resolver，不强制重复导入 Kubo。

写入不等于 pin：pin 或等效保留负责抵抗 GC。
没有独立 GC 的会话级存储可以通过持有资源保证可用；
会执行 GC 的后端必须有明确的保护机制。
写入 Kubo 可能伴随该节点正常的网络活动，不能承诺绝不对外提供内容。

Kubo RPC 具有节点管理权限，只由受信任宿主访问，
不能交给 App 的浏览器代码或公开预览页面。

### 8.3 本地变化处理

此前对持续预览确认的生命周期思路：

```text
监听源变化
→ 合并重复事件
→ 开始受保护的构建
→ 生成并写入 UnixFS blocks
→ 完成根 CID
→ 校验新 bundle
→ 新版本有效后替换展示
→ 旧版本没有读取者后释放本次保留
```

保护必须从构建中间 blocks 开始，不能等根 CID 得到后才进行。
保留范围还要包含所需外部 Schema 和 App 依赖。
失败和过时构建释放自身保护，不删除共享 blocks。
快速变化产生的旧异步结果不能覆盖更新版本。

“一个不可变导入结果”不自动等于“文件系统同一时刻的快照”：
导入期间本地文件也可能变化。来源适配需检测不稳定读取或重建，
不能把混合版本称作已捕获的同一次源快照。
具体一致性保证和实现方案需要单独确认。

### 8.4 通用 App 下不能照搬自动重跑

上述流程最初针对只读 Viewer 的持续预览。
改为通用 App 后，文件变化可能触发有副作用的程序，
所以不能自动把“展示刷新”解释为“Task 再执行一次”。

需要进一步定义：

- App 是否支持接收新的内容 CID。
- 是更新现有实例、重新启动，还是仅提示有新版本。
- 哪些动作要求用户再次授权。
- 如何取消旧任务、展示执行结果和防止重复副作用。

因此，持续预览需求与资源保护思路保留，
但 IPAB 的 `watch` 命令及通用应用更新契约尚未定稿。

## 9. 状态、生命周期与信任边界

应用配置和内容存储分开：

- 应用状态目录保存默认应用关联、打开浏览器偏好等配置。
- Content Bundle、Schema 和 App blocks 复用内容 Store，
  不因为角色不同而各自复制一份存储。
- 监听、HTTP 服务、应用实例、构建和单次读取具有明确所有权与取消方式。
- 只回收本次拥有的资源，不解除用户或其他进程的 pins、不清空共享缓存、
  不停止调用者已有的 daemon。

CID、Schema 验证和默认关联都不是执行权限：
执行 App 必须得到明确的信任和权限授权。
宿主提供的内容访问应限制在批准的快照及必要依赖，
而不是任意本地文件或 Kubo 管理代理。
具体权限表示、浏览器隔离与 Node App 能力由 runtime/profile 设计确定。

HTTP listening、App 启动、实际展示或任务完成是不同状态。
不能把“已取得 URL”或“已通过 Schema”当成执行成功。
错误应提供路径、数据字段位置和引用链，并明确区分读取失败、校验失败、
启动失败、执行失败与清理失败。

最初的预览要求不暴露资源预算为 CLI 参数，
但内部限制和超时仍需执行；未来扩展执行场景时，
是否存在真正的业务参数必须重新建模，不自动继承无限资源假设。

## 10. 代码归属与下一阶段

目前建议的迁移边界：

1. 将 content-bundle 源码、测试、文档和交付声明迁入本仓库，
   建立唯一维护位置，不让两边长期分叉。
2. 新建 IPAB 宿主，选择性复用 ipfsaw 的浏览器宿主、Task 加载、
   流式资源访问和会话清理，不整包照搬旧 CLI 和 Renderer ABI。
3. IPFS Store、Task SDK/Protocol/Builder/Engine 等已有公共包继续作为依赖，
   不复制其实现。
4. Check Viewer 等领域应用按需作为首个 App 示例迁入，
   不作为通用宿主必需依赖。

迁移前要确定包 identity、源码链接、版本和 Trusted Publisher 的仓库绑定；
新仓库建立不代表已有发布授权自动迁移。
本轮只完成工程脚手架，迁移和业务实施均尚未开始。

下一步优先完成：

- App Bundle profile 和唯一 CID 参数的准确契约。
- Content/Schema 到 App 的默认关联及一次性打开方式。
- Task Invocation 内容格式及任务结果处理。
- 内容来源适配、Store 写入和构建期保留。
- 展示与执行两类 App 的生命周期、权限和本地变化行为。
- 在上述模型明确后，重新生成并逐项确认 IPAB CLI Spec。

这些设计应复用现有协议并保持最小边界，
不因为追求统一入口而制造新的执行引擎、通用管理平台或多余配置层。
