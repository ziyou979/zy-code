# Gemini 原生协议检查（2026-10-14）

范围为 Vertex Gemini 的 `generateContent` / `streamGenerateContent`，以及共用 Google 转换层。认证仍使用 ADC，不切换到 OpenAI 兼容接口。

## 已修复并验证

| 问题 | 修复 | 验证 |
|---|---|---|
| 工具结果和 `go on` 被合并到一个 user Content，Gemini 4 返回 `Requests ending with a model turn are not supported` | Gemini 转换层把函数响应和新用户输入拆为独立轮次 | 同一虚构 echo 历史：修复前混合请求返回 400，独立轮次成功；修复后两种输入均成功 |
| 顶层 `CreateParams.system` 未传递，多条 system 消息只保留最后一条 | 合并为 `systemInstruction.parts`，不加入普通对话轮次 | 系统指令与历史 system 消息组合测试 |
| 通用清理丢失工具元数据 | 工具字段清理保留 providerMetadata | Bash 签名经过序列化、归一化、缓存转换后原样回传 |
| 签名可能在空文本尾包中，清理还会修改签名 Part 的文本 | 文本块支持不透明元数据，空签名块保留，带签名文本不修剪；流结束事件把尾包元数据交给消息保存层 | 空文本尾签名、原文空白和签名 Part 位置测试 |
| 空文本签名尾包提前关闭正文，但更早的思考块直到 STOP 才关闭，导致正文后才显示“思考了” | 分离签名尾包前按原始块顺序关闭前面的文本/思考；旧会话仅在 UI 中把同一响应的思考显示到正文前 | 原生 thinking → text → 空签名/STOP 序列在修复前 stop 顺序为 1、0、2，修复后为 0、1、2；UI 不改变历史或签名 |
| 并行工具块分成多条 assistant/user 消息 | 合并相邻 model Part 和纯函数响应，但不把新的用户指令混入函数响应 | 同名并行调用、仅首调用携带签名、ID 配对测试 |
| 收到函数调用即提交工具，后续断线/截断可能回退并重复执行 | 缓存工具调用，整轮明确成功后再交付执行器；保留后续收到的签名和最终参数 | 断流、MAX_TOKENS、延迟签名和参数更新测试 |
| 空闲看门狗清理闭包引用准备阶段的 undefined，而非实际运行中的流 | 流、Response 和清理函数由查询执行函数统一持有 | Vertex 流控制器取消测试与空闲看门狗测试 |
| 非流式回退期间 UI 仍显示思考 | 回退时通过已有状态接口切换为 requesting | 原有查询与状态回归检查 |
| Gemini 2.5 混用 thinkingLevel，Gemini 3 混用预算 | 2.5 使用预算，3 使用强度，4 保留 LOW/MEDIUM/HIGH；较新模型删除已弃用采样字段 | 模型分代请求参数测试 |
| 安全拦截没有 candidate/finishReason 被误判为断线 | promptFeedback.blockReason 转为 content_filter，保留用量 | 转换层和 Vertex 适配器测试 |
| SSE 按单行 JSON 解析，未处理多行 data | 按空行分隔事件，拼接 data 行，保留跨 UTF-8 分包和 EOF 支持 | 多行 data、CRLF、跨包和 Code Assist 信封测试 |
| 分开的用量尾包覆盖之前的统计 | 合并已出现的计数，保留思考 token 数；只发送一次最终用量事件 | 输入/输出/思考计数尾包测试 |
| 长输出检查点被当作结束，非流式回退还会压低总预算 | Vertex 在 v1beta1 接续 CONTINUATION，保持原始 prompt 和预算；MAX_TOKENS 不提额，重复/缺失令牌停止 | 流式和非流式仅思考检查点、取消、重复令牌、v1 端点测试 |
| 分段思考签名可能合并，非流式残缺工具可被误判成功 | 已签名 Part 与后续内容分离；工具仅允许成功完成且参数完整时执行 | 跨检查点独立签名、MAX_TOKENS/SAFETY/部分参数拒绝测试 |
| 并行工具结果的完成顺序不一定等于调用顺序 | 回传时按调用 ID 排序结果，不修改原始历史 | 反序完成的并行结果测试 |
| 思考计数未计入总输出、续传输入累计可能误触发压缩 | 输出包含思考；每段末用量求和，原始 prompt 单独保留用于上下文估算 | 分段累计快照、单独尾包、计费与上下文分离测试 |

## 发送前约束与当前边界

- 生成请求需要实际用户输入或工具结果作为尾轮次；空请求和 model 尾轮次在本地返回 400，避免相同请求重复发送。token 计数不套用生成的尾轮次限制。
- 不伪造思考签名，不用 `skip_thought_signature_validator` 绕过验证，不重放已执行命令来“修复”历史。
- 暂未实现 `streamFunctionCallArguments` 的 JSONPath 片段合并。不会主动开启；若服务端仍返回片段，则明确报错且不执行工具。
- 工具结果中的图片尚未映射到原生 `functionResponse.parts`；普通用户消息的文本/图片输入已支持。音频、视频仍超出当前消息通道实现范围。
- Vertex 长解码仅接续明确的 CONTINUATION 和有效令牌，使用原始请求及同一取消/非流式超时预算；不追加“继续”或部分模型输出，不在 MAX_TOKENS 后自动提额。流中途断线后不重放旧检查点，因为尚未实现已显示内容的检查点回滚。Google 旧 SDK 和 Code Assist 路径未实现续传，遇到检查点会明确报错。
- 未改变用户选定的思考强度，也未增加自动评测请求。没有结束标记的“只有思考”响应仍按未完成处理；网络空闲与完成后无正文须通过原始响应摘要区分。

## 诊断

`[api:vertex]` 输出请求轮次、尾角色、工具数、系统提示长度、输出上限与思考强度，以及首次出现的 thinking/text/tool 阶段、30 秒无 SSE 包警告和最终汇总。汇总包含正文/思考字符数、函数调用 Part 数、finishReason 和 token 计数，不输出正文、工具参数、签名或认证头。

日志判断：`completed=false` 表示没有完成标记；`finishReason=MAX_TOKENS` 且正文为空可能是输出预算被思考消耗；`STOP` 且无正文/工具需要继续检查响应是否仅包含思考。渲染器尺寸诊断仅在宽高变化时记录，避免动画刷新淹没网络日志。

### 抓包核对结果（2026-10-14）

- 显示乱序已由抓包确认：服务端返回思考、正文、空文本签名，本地旧会话保存为正文、思考、签名。对应上表的块提交顺序修复。
- 工具后续请求中的 Glob 签名与上游原始签名逐字一致，函数结果轮次也正确；不能将此后的连接故障归因于签名丢失。
- claude-tap 上游 SSE 日志出现 `ClientPayloadError`、传输长度不足和 `SSL: RECORD_LAYER_FAILURE`，随后非流式回退多次返回代理生成的 502 `Server disconnected`。故障发生在代理读取 Google 上游的 TLS 响应时，具体网络环节仍需独立验证。
- 一次非流式回退最终返回 HTTP 200、`MAX_TOKENS` 和 candidate 级别的 `continuationToken`。输出计数 28803 + 思考计数 3965 = 32768，达到回退请求设定的上限；内容只有思考摘要。客户端在 16:39:11 已报超时，代理在 16:39:13 才完成记录，因此还应区分客户端超时和上游最终停止原因。
- `thoughtSignature` 保留推理/工具上下文，`continuationToken` 续接同一次未完成生成，两者不可互换。抓取该记录时尚未实现长解码续传，本轮已补上 Vertex 的检查点循环。官方规定：`CONTINUATION` 可在既定预算内续传；`MAX_TOKENS` 携带续传令牌表示已经达到用户请求的总输出上限，需要提高上限才能继续，不能无条件自动提高额度。续传必须重发原始 contents/systemInstruction/tools，不追加部分模型输出或“继续”提示。
- 后续同一会话成功完成连续三次流式请求：两次 Write（约 4 分 19 秒、3 分 28 秒）和最终正文（约 18.5 秒），均为 HTTP 200/STOP，没有续传令牌。仍使用 HIGH、49152 输出上限；两次 Write 的签名均在下一请求逐字回传，生成的工具正文各约 8 万字符。这验证了多步工具调用链路可运行，长时间无可见正文也可能是在生成较大的工具参数。首次 Write 总生成量为 32741 token，接近此前非流式回退的 32768 上限；单次成功不能证明此前 TLS 故障已消失。

### “2.3k 后卡住”的时间对齐

2026-10-14 17:00 会话的 debug 与代理日志（以下均为 UTC+8）：

| 时间 | 证据 |
|---|---|
| 17:01:05 | Vertex 返回 200，开始收到思考 SSE |
| 约 17:02:43 | 最后一个 SSE；30 秒及 150 秒空闲警告可反推该时间 |
| 17:03:13 | 原生计数停在 28 个 SSE 包、9274 个思考字符，正文和工具 Part 均为 0，无 finishReason |
| 17:05:20 | 原生流 `completed=false`，用户信号未取消；代理上游报 SSL RECORD_LAYER_FAILURE 与 ClientPayloadError |
| 17:05:42 | 非流式回退收到代理生成的 502/WinError 64 |
| 17:10:06 | 再次回退收到 502/Server disconnected，仍继续重试 |

Spinner 使用 `responseLengthRef / 4` 估算 token，因此 9274 字符显示约 2319（2.3k）；这不是上游用量，也不是预算上限。断线发生在最后 SSE 后约 157 秒，早于本地 300 秒硬空闲超时，没有 MAX_TOKENS 完成标记。

当前未启用 `streamFunctionCallArguments`。官方说明，未启用时须等待完整工具参数生成；成功请求也在思考摘要之后静默约 2～3 分钟，再一次返回大体积 Write 参数。这支持“摘要结束后正在生成工具参数”的解释，但不能仅凭静默确认失败请求的内部生成阶段。网络故障的具体设备/跳点仍未定位。

另外该会话在请求开始前出现 useTypeahead/clearSuggestions 的 React 更新循环，属于独立 UI 问题；它不能解释代理进程记录的上游 TLS 错误。诊断期间可用 `ZY_CODE_DISABLE_NONSTREAMING_FALLBACK=1` 与 `ZY_CODE_MAX_RETRIES=1` 限制失败请求的放大，再对比显式 mixed 代理与 TUN 路径。此处仅记录建议，未自动改变用户的网络设置或重试配置。

### 限流、超时与代理配置核查

- 当前用户 settings 未覆盖 API_TIMEOUT_MS、ZY_CODE_MAX_RETRIES、CLAUDE_STREAM_IDLE_TIMEOUT_MS、CLAUDE_ENABLE_STREAM_WATCHDOG 或非流式回退开关。未发现按 2.3k 思考量终止请求的配置；界面的值来自字符估算。
- ZYCode 默认流空闲上限为 300 秒，本地非流式请求上限为 300 秒；claude-tap 上游配置为总计 600 秒、连续读取空闲 300 秒。17:05 的失败发生在最后 SSE 后约 157 秒，不能用这些已核实的超时解释。
- 抓取故障时流式实际发送的输出上限为 49152，Gemini 4 非流式适配器另有 32768 上限。后者确实解释前述 HTTP 200/MAX_TOKENS，但不解释没有完成标记的 TLS 断流；本轮已移除回退降低总预算的逻辑，并补上续传。输出预算与请求频率限流应分别诊断。
- 当前 Clash Verge 运行配置是 TUN/system 栈、MTU 1500、mixed-port 7897，系统代理关闭；所检查的配置未发现显式速率或带宽限制。配置可能在故障后改变，不能据此断言此前网络路径完全相同，也不能排除远端节点或上游容量问题。
- Clash 应用日志记录 17:11:55 节点延迟检查失败（tls handshake eof），17:12:08 停止核心并退出；紧随其后的 17:12:20 请求报 WinError 64。这支持后续失败与代理退出有关，但该退出发生在 17:05 首次 TLS 故障之后，不能反推首次故障也由退出导致。
- 已核对的抓包中没有 Google 返回的 429/RESOURCE_EXHAUSTED；502 是 claude-tap 在上游连接异常后生成的响应。Google 文档把配额不足列为 429 的原因，并指出过载也可能产生 500，因此这里只能判断当前没有配额限流证据，不能仅凭状态码排除所有服务端问题。
- 默认失败重试最多 10 次，即最多 11 次尝试；断流后另有非流式回退。这会放大等待与请求数量，并可能重新消耗生成额度。当前没有自动修改全局重试或网络配置。

## 登录与本轮验证

`/login` 不再按当前 Vertex 连接直接跳过菜单，统一显示 OAuth、Vertex ADC、API Key 和第三方平台入口。Vertex 校验或刷新成功会明确回传 ADC 登录类型，不再触发删除历史思考块的账户切换清理。

- 参数、签名、续传、工具、取消、Code Assist 和上下文相关测试：98 通过。
- 全量：2250 通过、1 跳过、16 失败；失败项与此前记录逐项一致，没有新增失败。
- `bun run format`、`bun tsc --noEmit`、修改文件 Biome 检查、中英文翻译一致性和 CLI 构建通过。
- Windows ConPTY：已配置 Vertex 时显示统一菜单，其他入口可见，Vertex 子页可返回菜单；进入 Vertex 后用虚构 ADC 校验成功，回调记录为 google-adc。没有发送付费生成请求。
- 架构检查仍被此前已有的 `services/api/anthropicProviderAdapter.ts:161` 类型断言阻挡，该文件本轮未修改。

上述检查验证当前支持的 Vertex 文本、图片输入和工具调用路径，不代表网络中断已被协议改动消除；中途断流后的旧检查点回滚、工具结果内图片、音频和视频仍是明确边界。

## 官方依据

- [请求、角色和 systemInstruction](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/inference)
- [模型尾轮次及采样参数变更](https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.6)
- [思考签名、空文本尾包与并行调用约束](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- [工具调用、函数响应、参数分片](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling)
- [按模型代际选择思考参数](https://ai.google.dev/gemini-api/docs/generate-content/thinking)
- [Gemini 4 长解码、预算上限与续传约束](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon)
- [配额、过载、超时错误与重试建议](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/api-errors)
