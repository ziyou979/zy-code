# ChatGPT 订阅认证审查（2026-10-01）

本次 `401 missing header` 的根因是认证存储契约不匹配。新登录流程在
`auth.json` 顶层写入字符串 `deviceId`，但解析器逐项要求连接对象；结果整份
文件被视为无效，普通 API key 和已有 OAuth 凭据均读不到。本机配置也命中了
这一条件。修复后直接读取原配置即可恢复，无需删除主机标识或重新填写密钥。

本次修复：

- 认证存储层显式声明主机标识元数据，连接枚举排除它；主机标识不做模块缓存，
  不会跨认证目录串用，且保存失败时停止注册。
- ChatGPT 默认保存为 `openai-chatgpt` 命名连接，底层 provider 为 `openai`。
  与 Codex 的 `openai` 连接分开保存，API key 连接不会借用其他连接的 OAuth。
  已有订阅凭据仍按其实际连接读取和刷新，不强制迁移用户配置。
- 适配器分派遵循实际凭据的优先级；显式 API key 不受连接中残留的 OAuth
  影响。迁移只处理旧全局 OAuth 块，不再把已有命名连接复制回默认连接。
- 授权码交换和刷新均使用 OpenAI 签发的 client ID；首次注册占位 ID 只用于
  发起授权。刷新可沿用未变化的 scope 和 ID token。
- 订阅请求强制使用公开端点、`store: false` 与 SSE；非流式业务消费终止快照。
  所有 extras 合并后再裁剪受限字段，保留官方未禁止的 `prompt_cache_key`。
- 流内失败保留错误码，便于区分额度与临时故障；订阅断流不伪装成成功。
  订阅通道关闭 SDK 自动重试，由上层错误分类控制重试。
- 浏览器回调与手动输入真正竞争，取消信号结束等待并释放服务器。
  缺失字段提示不会输出已返回的令牌。

架构判断：OAuth 登录与刷新放在 `services/oauth/providers`、认证文件 IO 放在
`services/auth`、协议差异放在 API 适配边界，这些职责划分合理。原实现没有同步
存储 schema、共享默认连接，并遗漏了 SSE 约束，导致新增认证污染正常对话。
本次修复这些边界，但新登录入口仍应维持默认关闭。

使用新订阅连接时，`settings.json` 模型引用的 `provider` 填命名连接 ID
`openai-chatgpt`，模型名称使用该账号实际可用的 slug。现有 `openai` 引用继续
使用其原来的认证方式，新增登录不应自动改写已有模型配置。

正式开放前仍需完成：

- ID token 的 JWKS 签名、issuer、audience、expiry、nonce 验证，以及返回账号的
 身份匹配；当前只保留 ID token，不能据此声称已验证账号身份。
- 同一会话的跨进程刷新锁和原子凭据替换，避免轮换 refresh token 被并发消费。
- 按注册 client ID 与已验证身份管理多个 ChatGPT 账号，并实现远端会话撤销。
  当前默认连接仅承载一个 ChatGPT 账号。
- 获取账号实际模型目录，核对可用模型及受限工具；本次不改现有模型选择系统。

协议依据：[注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、
[账号与刷新](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、
[推理限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。
本次协议测试使用模拟响应，未消费真实订阅额度。
