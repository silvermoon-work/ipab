# Pointers service：swarm root pointer API

**状态：API 与本地实现已完成，尚未部署验证。**
实现位于 [pointer-worker](../packages/pointer-worker)，
完整 CLI 入群与同步流程仍未接入。
对应用户链路见 [MVP 主链路](mvp-user-journey.md)，授权要求见
[swarm 授权](swarm-authorization.md)。

## 服务边界与身份

一个服务可以承载多个 swarm。服务端创建不透明的随机 pointer ID，
每个 pointer 对应一个 swarm，维护一个 root 和一个单调递增的 revision。
root 是共享发布记录的 CID，发布记录链接 State 和前次发布；
State 保存 Name → CID 映射及 swarm 的可变 properties。
服务不存储、遍历或合并这些 Bundle，不为每个 Name 创建变量。

用户以不可变 **Swarm Bundle CID** 标识 swarm。描述 Bundle 的 entry 为：

```json
{
  "service": "https://pointers.example.com",
  "variable": "<服务端返回的 pointer ID>",
  "owner": "<完整 Ed25519 公钥>"
}
```

这里保留已确认的描述字段 `variable`，其值就是 API 的 `id`。
描述中的 owner 必须与服务登记的公钥一致，成员不能用请求里的其他公钥
替换信任根。同一个账号身份可以创建多个 pointer，也可以加入其他 swarm。
日常操作不改写 Swarm Bundle；名称与描述的变化发布到 State。

服务 URL 是固定的协议 audience：HTTPS origin，不含凭据、查询、fragment
或业务路径。仅本地开发允许 HTTP loopback origin。
服务端显式配置它，不能根据请求的 Host 或转发头临时决定信任目标。

## API key 与 cfg

服务运营者预先生成一个 API key，分发给获准创建 swarm 的用户。
key 使用安全随机生成的 32 字节，以无填充 base64url 编码；服务端只配置
其 SHA-256 校验摘要，不记录或回显请求中的 key。
此阶段不实现服务登录、OAuth 或一次性创建许可。

客户端保存：

```text
pointers.service = https://pointers.example.com
pointers.apiKey = <API key>
```

IPAB CLI 已支持这两个 cfg 键；服务运维工具使用显式参数、环境变量或受保护的
平面 JSON cfg，不直接读取 IPAB 的 SQLite 配置。
cfg 只允许所属 OS 账号访问；Unix 使用文件权限，Windows 使用 ACL。
配置查询与保存确认的文本和 JSON 均隐藏 key，错误、历史和日志不得记录它。
key 不进入任何公开 Bundle。写入 key 的交互不得依赖把秘密放进命令行参数。

API key 只允许创建资源，不赋予已有 pointer 的 owner/member 资格。
创建时使用 `X-API-Key`，日常 GET/PUT 不发送它。
客户端只向 cfg 中明确绑定的 origin 发送 key，不能因为获取了外部
Swarm Bundle 就把本机 key 转发给描述中的服务；跨 origin 重定向同样不能携带 key。

本设计有意取代此前“本次服务授权凭据不持久保存”的要求；
保存 API key 不等于保存 swarm 身份私钥到服务端。

## 三个接口

| 方法 | 路径                | 用途          | 授权                         |
| ---- | ------------------- | ------------- | ---------------------------- |
| POST | `/v1/pointers/`     | 创建 pointer  | API key + owner 直接签名     |
| GET  | `/v1/pointers/{id}` | 读取 root     | owner/member 签名            |
| PUT  | `/v1/pointers/{id}` | CAS 更新 root | owner/member 签名 + If-Match |

`id` 由服务端安全随机生成，不是用户选择的名称，也不是密码。
正常响应不包含 owner 私钥、成员证书或 API key。
所有响应使用 `Cache-Control: no-store`。
可保留不含 pointer 状态的服务存活检查，但不提供公开 root 读取。

### POST：创建

```http
POST /v1/pointers/
X-API-Key: <API key>
Idempotency-Key: <本次创建操作的随机 ID>
Authorization: Ed25519 <signature>
```

```json
{
  "owner": "<完整 Ed25519 公钥>",
  "root": "<初始发布记录 CID>"
}
```

服务验证 API key，并用 body 中的 owner 公钥验证持钥证明。
登记初始 root，revision 为 `"1"`，成功返回：

```http
HTTP/1.1 201 Created
Location: /v1/pointers/<id>
```

```json
{ "id": "<服务端生成的 pointer ID>" }
```

创建重试使用同一个幂等键，不能再分配另一个 pointer。
请求参数不同则返回 `409 idempotency_conflict`。
创建结果必须在 pointer 完成持久初始化之后才能确认；
索引或创建记录和 pointer 分处不同 Durable Object 时，必须能从部分失败恢复。

IPAB 的顺序是：准备初始 State 与发布记录 → 创建 pointer → 取得 id →
构建并提供 Swarm Bundle → 最终输出其 CID。
初始记录不得依赖尚未生成的 Swarm Bundle CID，避免循环引用。
HTTP 返回的 `{id}` 与 IPAB 创建命令的 `{"cid":"..."}` 是不同层次的结果。
若描述 Bundle 构建或提供失败，保留已取得的 id，以便恢复，不重新创建 pointer。

### GET：读取

```http
GET /v1/pointers/{id}
Authorization: Ed25519 <signature>
```

```http
HTTP/1.1 200 OK
ETag: "12"
```

```json
{
  "root": "<当前发布记录 CID>",
  "revision": "12"
}
```

revision 是无前导零的正十进制字符串，不使用 JSON number，
不以时间戳或 root 内容决定版本顺序。
客户端固定本次读到的 root，再按 CID 获取和校验 State。
获取失败不能把旧缓存冒充为当前状态。

### PUT：更新

```http
PUT /v1/pointers/{id}
Authorization: Ed25519 <signature>
If-Match: "12"
Idempotency-Key: <本次发布操作的随机 ID>
```

```json
{ "root": "<候选发布记录 CID>" }
```

仅当前 revision 等于 If-Match 时持久更新 root，并将 revision 加一。
成功返回 `200`，body 与 GET 同形，ETag 为新 revision。
只接受单个强 ETag，不接受 `*`、弱 ETag 或版本列表。
缺少 If-Match 返回 `428 precondition_required`；
格式错误返回 `400 bad_request`；版本不匹配返回 `412`：

```json
{
  "error": {
    "code": "precondition_failed",
    "message": "pointer revision has changed",
    "details": {
      "root": "<当前发布记录 CID>",
      "revision": "13"
    }
  }
}
```

冲突响应同时提供当前 ETag，但必须先验证调用者资格。
只传新 root，不重复传旧 root；revision 足以识别基线并防止 ABA。
即使新 root 与当前相同，一次新的成功 PUT 仍递增 revision。
幂等重试是例外，返回原提交结果，不再次递增。

服务只判断全局 CAS。IPAB 刷新 State 后检查目标 Name 的旧发布节点：
目标未改变时，保留其他 Name 的更新，重建候选发布记录，再以新 revision
提交；目标已改变时报告编辑冲突。不能仅替换 If-Match 重发旧候选 root。
不同候选提交使用新的幂等键；网络重试同一候选才复用原键。

## 请求签名与防重放

不提供 challenges API，不向服务申请随机挑战。
客户端为每次请求生成安全随机 nonce，并附上当前 Unix 秒：

```http
Authorization: Ed25519 <base64url signature>
X-Pointer-Timestamp: <Unix 秒>
X-Pointer-Nonce: <安全随机 nonce>
```

nonce 至少包含 128 位随机熵。时间戳允许服务端时钟 ±60 秒偏差。
服务持久保存已消费的 nonce 至少 130 秒；每个 pointer 独立去重，
创建操作在创建协调存储中去重。
到容量上限时拒绝新请求，不能提前丢弃未过期记录以换取成功。

签名必须覆盖以下字段，由共享协议编码器定义唯一、无歧义的字节编码：

- 协议版本和配置的服务 origin；
- pointer ID（集合创建请求为空）、HTTP 方法和完整路径；
- 原始请求体的 SHA-256；
- If-Match、Idempotency-Key；
- 时间戳、nonce，以及协议使用的其他授权相关参数。

当前实现使用 v2 协议，签名内容为 UTF-8 JSON tuple，避免自由文本字段的
分隔符歧义：

```text
["IPAB-POINTER/2",service,id,method,path,bodyHash,ifMatch,idempotencyKey,timestamp,nonce,signerPublicKey]
["IPAB-POINTER-CERT/2",service,id,owner,member,cid,iat,exp]
```

`signerPublicKey` 为请求签名公钥，`cid` 在证书 tuple 中是证书标识，
不是内容 CID。最终字段定义以共享协议实现为准。

更改其中任一字段均不能沿用原签名。
POST 的 owner 与初始 root 通过请求体哈希绑定；日常请求通过
服务 origin 与 pointer ID 隔离 swarm，无需提前知道 Swarm Bundle CID。
时间窗口已经限制请求时效，不另引入 access token 或可复用 bearer 签名。

更新的 nonce 消费、CAS、root/revision 以及成功幂等记录必须原子持久提交，
不能在持久写入失败时返回成功。确认过的状态在重启后不能回退。
客户端网络重试生成新的 nonce 和时间戳，沿用同一操作的幂等键。

## owner 与 member

owner 请求直接由服务登记的 owner 公钥验签，不要求自签成员证书。
member 请求携带 owner 直接签发的成员证书，并用自身身份私钥签请求。
证书的签名内容至少绑定：

- 目标服务 origin 与 pointer ID；
- 成员完整公钥；
- 有效期及证书标识。

证书授权范围对应 Swarm Bundle 中的 service、variable 与 owner 绑定。
客户端加入时还须核对授权响应对应自己的准确请求 Bundle CID。
不能只比较指纹，不能因两个 swarm 共用 owner 公钥就接受跨 pointer 证书。
MVP 所有有效 member 均可读写；只有 owner 能签发成员证书，
不提供 CA 委托链或 member 再授权接口。

## 幂等、限制与错误

创建与更新支持签名覆盖的 `Idempotency-Key`，客户端为可重试的操作设置它。
幂等记录绑定已验证的签名公钥、操作目标、请求体和 CAS 条件，
不能仅按自由填写的 subject 判断身份。
新请求仍须通过当前授权、时间戳与 nonce 校验，再返回已保存的原结果。
在至少十分钟的保留窗口内，相同操作不重复执行；
不同参数复用同一键返回 `409`，不能通过淘汰未过期记录破坏窗口承诺。
窗口结束后不能声称提供永久 exactly-once；创建者应持久保存已取得的 id。

当前实现将成功创建／更新的重试结果保留 600 秒，重试不延长窗口；
过期结果在后续操作时惰性清理，重启后仍遵守已保存的过期时间。
服务级创建分配最多 200 条，每个 pointer 的写重试结果最多 200 条；
容量满时返回 `429`，不淘汰仍有效的记录。
未完成的创建分配不按成功结果的窗口删除，仍计入容量：
携原幂等键重试可从初始化或确认失败中恢复。
丢失幂等键或未设置幂等键的失败创建需要服务运营者内部恢复，
不提供自动丢弃或公开删除接口；无幂等键的创建成功后释放分配记录。

输入必须使用严格形状校验，拒绝未知字段和非法 CID。
root 使用规范 CID 字符串，最多 256 UTF-8 字节。
当前实现的 body、编码证书与头字段总量上限分别为 4096、4096、16384 字节；
在解析前检查并有界读取，
限制的是整个输入，不只是解析后的 root。
服务不访问任意请求指定的 IPFS Gateway。

错误统一为 `{"error":{"code":"...","message":"..."}}`：

| 状态 | 场景                                         |
| ---- | -------------------------------------------- |
| 400  | 请求、CID、版本或签名字段格式错误            |
| 401  | API key、请求签名、时效或 nonce 重放校验失败 |
| 403  | 成员证书无效、过期或不属于该 pointer         |
| 404  | pointer 不存在                               |
| 405  | 不支持的方法                                 |
| 409  | 幂等键与已有操作不一致                       |
| 412  | 已授权写请求发生 CAS 竞争                    |
| 413  | 输入超出字节限制                             |
| 428  | 更新缺少 If-Match                            |
| 429  | 去重、幂等或请求容量达到限制                 |
| 500  | 存储或其他内部错误，不能确认成功             |

root 更新成功只表示发布指针已确认，不证明其他设备能获取内容。
完整跨设备共享仍须先提供 Bundle blocks，并验证对端可获取。

## 迁移与验收

目标 API 替换旧的具名变量、`/v1/value` 和管理面接口，
不是在其旁边增加第二套 API。服务随机分配 ID，不接收自选名称。
旧 root 值与根公钥不得静默转换或删除；若已有部署数据，迁移另行明确授权。
本阶段不提供删除、在线换 owner、密钥遗失恢复、成员撤销列表、服务迁移
或内容分发接口。

验证必须覆盖：创建持钥证明与 API key、同 owner 多 pointer、
成员跨 pointer/服务隔离、签名字段篡改、nonce 重放与容量饱和、
创建幂等与部分失败恢复、并发 CAS、更新幂等与重启后的持久状态。
Node 内存夹具可验证路由和协议，但不替代真实 Durable Object
事务、RPC 与故障恢复的部署前运行时验证。
