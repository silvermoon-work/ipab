# @ipab/pointer-worker

个人 swarm 的**全局状态指针服务**：每个内部 pointer 变量维护
一个可变的 `HEAD`，读写都要求 Ed25519 签名，写操作使用版本号做乐观锁。
服务运行在 Cloudflare Workers 上，每个 pointer 名对应一个 Durable Object。

本包是 private workspace 成员，不属于五个 npm 交付项；它目前只提供签名指针服务，
已接入 `ipab` CLI 的 swarm 同步流程。具体决策和授权政策见
[MVP 实现](../../docs/mvp-implementation.md)。需求背景见
[个人 swarm 的创建与授权需求](../../docs/swarm-authorization.md) 与
[项目愿景](../../VISION.md)。

## 架构

一个 Worker，多个 pointer：

```
<worker-host>
├── /_admin/v1/variables          → RegistryObject（pointer 索引，管理面）
├── /demo/v1/value                → PointerObject("var:demo")
└── /<name>/v1/value              → PointerObject("var:<name>")
```

- **值**保存在每个 pointer 自己的 `PointerObject` 中（SQLite-backed DO
  storage），
  不用 KV：KV 是最终一致的，也没有原子 compare-and-swap；DO 单实例串行执行，
  版本号比较才是精确的。
- **pointer 索引**（名字 → 公钥、创建时间）保存在一个 `RegistryObject` 中，
  只在管理面使用，不在数据热路径上。
- **锚定公钥**保存在每个 `PointerObject` 的配置里，创建时由管理面写入；
  数据请求先读配置，再用该公钥验签。
- **管理面**固定
  `POINTER_ADMIN_PUBLIC_KEY`，只接受该密钥直接签名（不接受证书链）
  来增删 pointer 和轮换公钥。

映射到 swarm 授权需求：pointer 名是 Descriptor 内部 variable，锚定公钥对应 swarm
owner 公钥，
值是发布记录当前的 `HEAD`（CID 字符串，≤256 UTF-8 字节）；`If-Match` 版本号
承载“预期旧根 → 候选新根”的比较并交换语义。映射表本身不存储在这里。

## 本地开发

```bash
cd packages/pointer-worker
pnpm install

# 1. 生成本地开发用的管理密钥（私钥只落在本地，不要提交）
pnpm cli keygen --subject admin --out .keys/admin.json

# 2. 让本地 Worker 读取管理公钥
printf 'POINTER_ADMIN_PUBLIC_KEY=%s\n' \
  "$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('.keys/admin.json','utf8')).publicKey)")" \
  > .dev.vars

# 3. 起本地服务（http://127.0.0.1:8787）
pnpm dev

# 4. 创建 pointer 并固定一个根公钥
pnpm cli admin create --key .keys/admin.json --name demo \
  --pubkey-file .keys/alice.json --url http://127.0.0.1:8787

# 5. 数据面：根密钥直接签
U=http://127.0.0.1:8787/demo
pnpm cli read  --key .keys/alice.json --url $U
pnpm cli write --key .keys/alice.json --value "target=staging" --url $U
pnpm cli read  --key .keys/alice.json --url $U

# 6. 给 Agent 签证书，Agent 用证书私钥签
pnpm cli certify --issuer .keys/alice.json --subject alice --out .keys/alice-ca.json \
  --read --write --scope-sub 'alice*' --days 30 --ca
pnpm cli certify --issuer .keys/alice-ca.json --subject alice/agent-1 \
  --out .keys/agent-1.json --read --write --scope-sub 'alice/agent-1' --days 7
pnpm cli read --key .keys/agent-1.json --url $U
```

`.dev.vars`（管理公钥）和 `.keys/`（私钥）已由根 `.gitignore` 排除，不要提交。
Swarm CID 是不可变 Descriptor Bundle；根密钥轮换与设备撤销仍在 CLI MVP 之外，
本服务只实现签名指针部分。

运行测试与类型检查：

```bash
pnpm --filter @ipab/pointer-worker test
pnpm --filter @ipab/pointer-worker test-coverage
pnpm --filter @ipab/pointer-worker typecheck
```

测试在 Node 中直接构造 Worker 路由与 Durable Object：`cloudflare:workers`
在测试时由 [vitest 配置](../../vitest.config.ts) 别名到
[test/cloudflare-workers.ts](test/cloudflare-workers.ts)，
Durable Object 使用内存版 `DurableObjectState`，不启动 workerd。

## 管理面 API

所有管理请求都用管理私钥按下面的签名串直接签名，带 `X-Pointer-Subject: admin`。

| 方法   | 路径                          | 说明                                          |
| ------ | ----------------------------- | --------------------------------------------- |
| GET    | `/_admin/v1/variables`        | 列出所有 pointer（name / pubkey / createdAt） |
| POST   | `/_admin/v1/variables`        | 创建，body `{"name": "...", "pubkey": "..."}` |
| GET    | `/_admin/v1/variables/<name>` | 查看单个 pointer（含 version / updatedAt）    |
| PUT    | `/_admin/v1/variables/<name>` | 轮换公钥，body `{"pubkey": "..."}`，值保留    |
| DELETE | `/_admin/v1/variables/<name>` | 删除 pointer 并清空它的 DO 存储               |

```bash
A="--key .keys/admin.json --url http://127.0.0.1:8787"
pnpm cli admin list   $A
pnpm cli admin get    $A --name demo
pnpm cli admin rotate $A --name demo --pubkey-file .keys/other.json
pnpm cli admin delete $A --name demo
```

Pointer 名规则：`^[a-z0-9][a-z0-9-]{0,40}$`，保留 `admin` / `health` / `v1`。
路径是单段，不支持 `a/b` 这种嵌套名。

## 数据面 API

| 方法 | 路径                      | 鉴权         | 说明                      |
| ---- | ------------------------- | ------------ | ------------------------- |
| GET  | `/<name>`                 | 无           | pointer 基本信息          |
| GET  | `/<name>/health`          | 无           | 存活检查                  |
| GET  | `/<name>/v1/capabilities` | 无           | 协议版本、上限、扩展      |
| GET  | `/<name>/v1/value`        | 签名 + read  | 读当前值                  |
| PUT  | `/<name>/v1/value`        | 签名 + write | 写新值，必须带 `If-Match` |

读响应：

```json
{
  "value": "target=staging",
  "version": 1,
  "updatedAt": 1800000123,
  "updatedBy": "alice/agent-1",
  "pointer": "demo",
  "signer": {
    "subject": "alice/agent-1",
    "keyId": "...",
    "certId": "...",
    "direct": false
  }
}
```

响应头 `ETag: "1"` 就是版本号。

写请求：

```http
PUT /demo/v1/value
If-Match: "1"
Content-Type: application/json

{"value": "target=prod"}
```

- `If-Match: "N"`：只有当前版本恰好是 N 才写，成功后版本变 N+1；
- `If-Match: *`：只在从未写过（version 0）时创建；
- 版本不匹配 → `412 precondition_failed`，响应体带当前值／版本，可直接重试；
- 值超过 256 个 UTF-8 字节 → `413 value_too_large`；
- 缺 `If-Match` → `428 precondition_required`。

乐观锁以**版本号**而不是“旧值”为准，所以 A→B→A 的 ABA 场景也会被拒绝。

可选请求头：

- `Idempotency-Key: <字符串>`：10 分钟内同一 key + 同一请求体返回第一次的结果，
  不重复写、不重复递增版本；
- `X-Pointer-Scope: {"read":true,"write":false}`：本次请求主动缩权（只缩不扩）。

### 错误码

`missing_auth` · `unauthorized` · `forbidden` · `replayed` ·
`precondition_required` · `precondition_failed` · `idempotency_conflict` ·
`conflict` · `unknown_pointer` · `value_too_large` · `bad_request` ·
`cert_invalid` · `cert_chain_invalid` · `cert_expired` · `cert_not_yet_valid` ·
`not_found` · `method_not_allowed` · `internal`

错误统一为 `{"error": {"code": "...", "message": "..."}}`；
precondition 失败时错误体额外带 `details.value` / `details.version`。

## 鉴权模型

每个 pointer 固定**一个**根公钥（创建时写入 `PointerObject` 配置）。
每个请求都必须带：

```
Authorization: Ed25519 <base64url(signature)>
X-Pointer-Timestamp: <unix 秒>
X-Pointer-Nonce:     <16..128 个 URL-safe 字符>
X-Pointer-Subject:   <签名者身份>
```

签名内容（`\n` 连接，全部字段参与）：

```
DSH-POINTER/1
<METHOD>
<PATH>
<UNIX SECONDS>
<NONCE>
<SHA-256(body) 十六进制>
<If-Match 原样>
<SUBJECT>
```

路径是**包含 pointer 名的完整外部路径**（例如 `/demo/v1/value`），
所以一张签名不能被换到另一个 pointer 上重放。时间戳 ±60 秒内有效，
nonce 在 120 秒内只能用一次（重放返回 `401 replayed`）。
管理面用同一套签名串与 nonce 防重放，只是固定用管理公钥验签。

### 模式 A：根私钥直接签

请求**不带** `X-Pointer-Cert`。Worker 用该 pointer 的根公钥验签，
签名者获得完整读写权限。

### 模式 B：根私钥签证书 → 证书私钥签请求

请求带一个或多个 `X-Pointer-Cert`（leaf 在前，CA 在后），外加
`X-Pointer-Subject`。Worker：

1. 用该 pointer 固定的根公钥验证整条链（签名、有效期、scope 包含关系）；
2. 要求 `X-Pointer-Subject` 等于 leaf 证书里的 `sub`；
3. 用 leaf 证书里的公钥验证请求签名；
4. 按 leaf 的 scope 判断这次操作是读还是写。

只发 leaf 证书（根私钥直接签发给 Agent）同样有效：链长度是 1，
但仍必须能验到根公钥。

证书链的每条约束：

| 约束           | 说明                                                     |
| -------------- | -------------------------------------------------------- |
| 签名           | 每条证书由下一条证书（或根公钥）签发                     |
| 身份连续性     | `child.iss == parent.sub`，`child.iss_pub == parent.pub` |
| 时间窗口       | 子证书的有效期必须落在父证书窗口内                       |
| 权限只减不增   | `child.scope ⊆ parent.scope`（read/write + 身份前缀）    |
| 身份范围       | 父证书的 `scope.sub` 必须覆盖子证书的 `sub`              |
| 只有 CA 能签发 | 父证书 `ca: true` 才能作为签发者，leaf 不能是 CA         |
| 链深           | 最多 5 层                                                |

证书是纯 JSON（base64url 后放进 header）：

```json
{
  "body": {
    "v": 1,
    "sub": "alice/agent-1",
    "pub": "<base64url 32 字节 Ed25519 公钥>",
    "scope": { "read": true, "write": false, "sub": "alice/agent-1" },
    "iss": "alice",
    "iss_pub": "<base64url 根公钥>",
    "kid": "<base64url SHA-256(pub)>",
    "cid": "<证书 id>",
    "iat": 1800000000,
    "exp": 1800086400,
    "ca": false
  },
  "sig": "<base64url 签名>"
}
```

`scope.sub` 支持尾部 `*` 前缀通配（例如 `alice/team*`）；
比较两条通配模式是否包含时只接受“前缀更具体”的情况，其余一律拒绝。

## 代码结构

```
src/protocol.ts        # 线上格式、签名串、scope 包含规则、pointer 名校验
src/crypto.ts          # WebCrypto Ed25519 / SHA-256 / 公钥解析
src/certificates.ts    # 证书签发、链验证、scope 收窄
src/verify.ts          # 请求解析 + 鉴权（Worker 的纯函数层）
src/state.ts           # 纯状态机：nonce、乐观锁、scope、幂等
src/pointer-object.ts  # 每个 pointer 的 DO：配置、值、nonce、幂等
src/registry-object.ts # pointer 索引 DO + 管理面 nonce 防重放
src/index.ts           # Worker 路由：数据面 + 管理面
src/client.ts          # 无依赖客户端（PointerClient / AdminClient）
scripts/cli.ts         # 运维 CLI（keygen / certify / read / write / admin）
wrangler.toml          # Worker 名、DO 绑定、管理公钥、可选路由
test/                  # Vitest 套件与内存 DurableObjectState 夹具
```

## 部署

`wrangler.toml` 已配置 Worker 名、DO 绑定和迁移。部署前：

1. 把 `POINTER_ADMIN_PUBLIC_KEY` 设为管理公钥（只填公钥，不填私钥）；
   留空会完全禁用管理面。
2. 需要自定义域名时，取消 `[[routes]]` 注释并替换成自己的 route；
   否则使用默认的 `workers.dev` 地址。

```bash
pnpm --filter @ipab/pointer-worker exec wrangler deploy
```

部署后可用管理密钥创建 pointer：

```bash
pnpm cli admin create --key .keys/admin.json --name demo \
  --pubkey-file .keys/alice.json --url https://<your-worker-host>
```

管理公钥本身要换时：修改 `wrangler.toml` 后重新 `wrangler deploy`；
管理密钥没有在线轮换接口，因为它是 Worker 的启动配置。

## 安全边界

- **管理私钥**可以增删 pointer、轮换任何 pointer 的公钥，必须离线保管。
  它不能直接读值，但可以轮换公钥后再读——等同于整个服务的控制权。
- **pointer 根私钥**只影响该 pointer；泄露后用 `admin rotate`
  换公钥即可，值保留。
- **重放**：数据面 nonce 记在 pointer 的 DO 里，管理面 nonce 记在 Registry
  DO 里，
  窗口都是 120 秒；管理面的 `POST` / `PUT` / `DELETE` 同样受保护。
- **篡改**：method / 完整路径 / body / `If-Match` / subject 全部在签名串里。
- **越权**：证书链每一条都做 scope 包含检查；读和写分别校验；
  证书有效期与父证书窗口都会校验。
- **删除**：`DELETE /_admin/v1/variables/<name>` 会清空该 pointer 的 DO 存储，
  不可恢复。
- **证书撤销**：当前靠短有效期 + `admin rotate` 重新签发；如需单证书立即吊销，
  可以加一个根密钥签名的 revocation list（DO 里存 `cid` 集合，验链时查）。
- **CORS**：默认关闭；设置 `ALLOWED_ORIGIN` 才会回 CORS 头。
- 保护 `HEAD` **不等于加密 IPFS 内容**：知道 CID 且能取得块的参与者仍可读取
  那个快照；`HEAD` 更新成功也不证明其他设备已取得新块。

## 已知取舍

- 数据请求会做两次 DO RPC：先读 pointer 配置（公钥），再执行读写。
  单 pointer 低 QPS 下可以接受；读非常多时可在 isolate 内缓存公钥。
- 每次读都会往 pointer 的 DO 写一次 nonce 记录（跨 isolate 的重放保护），
  这是安全性换写放大。
- 值只能是字符串，二进制／大对象请存 R2 / KV，这里存指针。
- pointer 索引在单个 Registry DO 里，管理操作串行；数据面不走它，
  所以 pointer 数量增加不影响读写延迟。
