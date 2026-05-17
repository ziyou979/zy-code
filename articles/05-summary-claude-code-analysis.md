# 四文精读：Claude Code 架构设计全景解读

> **综合整理** | 基于四篇 ATA 技术文章
> - 姜剑(飞樰)：《深度解析 Claude Code 在 Prompt / Context / Harness 的设计与实践》
> - 刘镇东(毅宸)：《Claude Code 源码深度架构分析》
> - 孙翔宇(柏锦)：《【Claude Code 源码分析】万行代码背后的 AI Harness 编码操作系统》
> - 陈以强(无岳)：《Claude Code 源码泄漏拆解：从启动到多 Agent 扩展层》

---

## 概述

这四篇文章从不同视角深度剖析了 Claude Code（基于 v2.1.88，约 38-51 万行 TypeScript）的架构设计。它们形成了一个完整的认知闭环：

| 文章 | 视角 | 核心贡献 |
|------|------|---------|
| 飞樰 | Prompt/Context/Harness 三维度 | 从 AI 系统设计方法论角度，提炼可复用的 Agent 设计模式 |
| 毅宸 | 源码深度架构 | 51 万行代码的系统性拆解，涵盖工具、权限、多 Agent、UI 等全部核心模块 |
| 柏锦 | Harness 编码操作系统 | 以 Harness 为核心，梳理 SDK/Bridge/Hooks/Plugins 扩展体系 |
| 无岳 | 启动到多 Agent 扩展层 | 从架构哲学出发，回答"为什么这样设计"而非"有什么功能" |

## 一、系统总览：Claude Code 不是什么？

**Claude Code 不是一个简单的"API wrapper"，而是一套完整的 AI 编码操作系统。**

它包含：
- 自定义终端渲染引擎（React + Yoga 布局）
- 多层上下文管理与压缩系统
- 并发工具执行与权限控制
- 多 Agent 协作与任务调度
- 插件/技能/MCP 扩展体系
- Bridge 远程控制与 SDK 进程内 API

四篇文章共同揭示了一个事实：**Claude Code 的工程复杂度远超同类竞品，它的核心价值不在模型本身，而在围绕模型构建的运行时系统。**

## 二、架构分层：七层复杂度安放

无岳的文章提出了一个精妙的总架构视图，将 Claude Code 拆成七层，每层承接一种特定的复杂度：

```
┌─────────────────────────────────────────────┐
│          用户 / 接口调用 / 远程客户端         │
├─────────────────────────────────────────────┤
│  ① 启动层 ── 模式、权限、会话边界             │
├─────────────────────────────────────────────┤
│  ② REPL / Host ── 输入、任务、权限、能力面     │
├─────────────────────────────────────────────┤
│  ③ Query Loop ── 上下文治理、推理、工具回灌    │
├─────────────────────────────────────────────┤
│  ④ Tool Runtime ── 校验、权限、并发、协议化    │
├─────────────────────────────────────────────┤
│  ⑤ Task Runtime ── 后台执行、多 Agent、回流    │
├─────────────────────────────────────────────┤
│  ⑥ MCP/Skills/Plugins ── 能力收敛层          │
├─────────────────────────────────────────────┤
│  ⑦ 文件/Shell/网络/IDE/外部服务               │
└─────────────────────────────────────────────┘
```

### 关键原则：复杂度被放到了对的位置上

- **边界问题**混进主循环 → 沉到启动层
- **权限问题**混进工具调用 → 独立为权限系统
- **多 Agent 问题**混进 prompt → 统一为任务抽象
- **扩展问题**渗透到系统内部 → 收敛为内部对象

> Claude Code 没有追求"最少模块"，而是追求"每种复杂度只在一个地方爆炸"。

## 三、三条主干链路

进一步抽象，七层可以收敛为三条主干链路：

### 1. 控制链：怎么想、怎么续跑

```
启动层 → REPL → Query Loop
```

- **启动层**先定边界：这次会话处在什么模式、什么权限、什么能力范围内运行
- **REPL** 汇总能力面：本地工具、MCP、插件、任务状态、权限队列
- **Query Loop** 接手连续运行：预算、压缩、预取、流式推理、失败恢复

**核心设计：** AsyncGenerator 驱动的流式架构，天然支持背压、取消、流式组合。

### 2. 执行链：怎么动、怎么受约束

```
Tool Runtime → Permission → Sandbox / Tool Call
```

- **Tool Runtime** 把工具定义为带完整运行时语义的对象（schema、校验、权限、并发安全、中断、结果回填）
- **Permission** 是完整的决策链：规则层 → 运行时判定层 → 交互层 → 执行隔离层
- **沙箱** 把逻辑权限压成文件、网络、命令等现实边界

**核心设计：** Fail-closed 安全默认——所有安全相关默认值都是最保守的。

### 3. 任务链：怎么并发、怎么持续、怎么回流

```
Task Runtime → 后台执行 / 多 Agent / 回流
```

- **统一 Task 抽象**：主会话后台化、本地 subagent、in-process teammate、remote agent 都映射到同一任务语义
- **四种 Agent 模式**：同步子 Agent → 异步后台 Agent → Coordinator 模式 → Team/Swarm 模式
- **结果回流**：任务通知、待处理消息、会话记录、产物最终都回到主会话

**核心设计：** 多 Agent 的前提不是 prompt 分工，而是统一任务抽象。

## 四、核心设计模式深度解析

### 4.1 Prompt Engineering：动态组装而非静态编写

飞樰和毅宸都详细分析了 System Prompt 的组装过程：

```
第 1 步：QueryEngine 发起请求
第 2 步：获取三大组件（defaultSystemPrompt + systemContext + userContext）
第 3 步：组装默认 System Prompt（静态 + 动态）
第 4 步：优先级决策（override > Coordinator > Agent > custom > default）
第 5 步：注入上下文信息（git status + CLAUDE.md）
第 6 步：缓存分块（global cache / org cache / no cache）
```

**关键洞察：** Prompt Engineering 的内涵已经从"怎么写好一段提示词"进化为"如何根据身份、行为、安全、任务、工具、约束等动态信息实时拼接和组装"。

### 4.2 Context Engineering：六层压缩 + 结构化记忆

**六层上下文压缩策略：**

| 层级 | 名称 | 触发条件 | 成本 |
|------|------|---------|------|
| L1 | Snip Compact | feature gate | 极低 |
| L2 | Micro Compact | 每次循环 | 无 LLM 调用 |
| L3 | Context Collapse | feature gate | 无 LLM 调用 |
| L4 | Auto Compact | token 超阈值 | 1 次 LLM 调用 |
| L5 | Reactive Compact | prompt_too_long | 紧急压缩 |
| L6 | Tool Result Budget | 每次循环 | 落盘 + 预览 |

**分级回退策略：** 首选 Session Memory Compact（无 LLM 调用）→ 降级 Full LLM Compact（不惜成本）。

**结构化记忆系统（Memdir）：** User / Feedback / Project / Reference 四种类型，LLM-in-the-loop 检索（Sonnet 模型，最多返回 5 条）。

### 4.3 Harness Engineering：外部可热闹，内部须收敛

柏锦的文章聚焦于 Harness 层，揭示了两核心入口 + 三扩展点：

**核心入口：**
- **SDK 模式**（进程内）：`@anthropic-ai/claude-code-sdk`，通过 AsyncGenerator 消费消息流
- **Bridge 模式**（远程）：claude.ai 通过 HTTPS 长轮询接入本地 Claude Code

**扩展点：**
- **Hooks：** 30+ 生命周期钩子，覆盖工具、会话、压缩、采样、Swarm 等全生命周期
- **Plugins：** 可提供 Skills、Hooks、MCP Servers、自定义命令
- **Coordinator 模式：** 主 Agent 通过 SDK 调度 Worker Agent

**核心设计原则：** 外部协议（MCP）会被翻译成内部对象（Tool/Command/Skill），内部抽象数量必须尽量少。

### 4.4 多 Agent 协作：从 prompt 分工到任务系统

四篇文章从不同角度剖析了多 Agent 设计，形成完整认知：

**四种模式层层递进：**

| 模式 | 特点 | 适用场景 |
|------|------|---------|
| 同步子 Agent | 等结果返回 | 单一任务委托 |
| 异步后台 Agent | 结果写磁盘，通过 TaskOutputTool 读取 | 耗时任务 |
| Coordinator 模式 | 纯编排者，四阶段流水线 | 大规模并行任务 |
| Team/Swarm | 平等协作，文件系统邮箱通信 | 长期协作开发 |

**内置 Agent 类型的设计哲学：**

| Agent | 模型 | 工具限制 | 设计决策 |
|-------|------|---------|---------|
| General-Purpose | 默认 | 全部工具 | 万能打工人 |
| Explore | Haiku | 只读 | 便宜、快速搜索 |
| Plan | 继承父模型 | 只读 | 高质量架构设计 |
| Verification | 继承父模型 | 只读（项目目录） | 独立验证，红蓝对抗 |
| Guide | Haiku | 有限 | 自我说明书 |
| Statusline | Sonnet | Read + Edit | 状态栏配置 |

**设计思考：**
1. token 成本：Explore、Guide 用 Haiku
2. 安全隔离：Verification 不能改文件，Explore 不能写文件
3. 上下文管理：子 Agent 工具输出不污染主 Agent
4. 并行效率：Verification 后台运行，不阻塞用户

### 4.5 权限系统：可解释的执行链

无岳的文章最精彩地阐述了权限系统的设计哲学：

```
tool_use → 规则匹配 → 直接执行 / 自动判定链 → 用户确认 → 沙箱内执行
```

**权限模式连续谱：**

```
plan → default → acceptEdits → auto → bypassPermissions
(最保守)                                     (最信任)
```

**关键设计：**
- 用户显式 ask 规则优先于 bypass 模式
- 敏感路径（.git/、.claude/ 等）免疫 bypass
- Auto mode 会主动裁剪过宽的 Bash、PowerShell 规则
- 沙箱是 permission 的落地点，不是独立安全层

### 4.6 安全体系：Fail-Closed 的工程实践

**多维度权限控制链：**

```
企业策略（MDM/Policy）
  ↓ 最高优先级
用户设置（settings.json）
  ↓
项目设置（.claude/settings.json）
  ↓
CLI 参数（--allowedTools, --permission-mode）
  ↓
工具自检（checkPermissions）
  ↓
AI 分类器（auto mode）
  ↓
用户确认（interactive dialog）
```

**Bash 安全分析（18 个文件）：**
- tree-sitter AST 解析 + 子命令独立权限检查
- flag 级验证（xargs -I vs -i 语义不同）
- 25+ 种命令注入检测
- 沙箱隔离（文件系统、网络、PID 命名空间）

## 五、五条最值得带走的设计原则

综合四篇文章，提炼出五条最核心的设计原则：

### 1. 先定义执行边界，再发起第一轮推理

启动层的价值不在于"复杂"，而在于**次序感**。凡是会影响执行边界的东西，尽量都在第一轮请求前定型。

### 2. 当 Agent 进入连续运行阶段，query loop 就必须升级成 runtime

连续运行从来不是一次模型调用能解决的问题。上下文治理、失败恢复、工具回灌，都是 runtime 课题。

### 3. 工具一旦开始碰副作用，工具层就必须制度化

校验、授权、结果格式三件事统一起来。工具有制度，Agent 才能从"会调用能力"变成"能稳定执行动作"。

### 4. 权限系统的核心不是确认框，而是可解释的执行链

把决策、理由、来源建模出来。让自动化、用户体验和风险控制走同一条链，而不是互相打架。

### 5. 多 Agent 的前提不是 prompt 分工，而是统一任务抽象

先把任何可持续执行的事情纳入统一执行体。多 Agent 真正从 demo 走向系统，靠的是任务系统能不能把分出去的执行重新收回来。

## 六、彩蛋与文化：Anthropic 的工程浪漫

飞樰的文章还挖掘了大量有趣的彩蛋设计，展现了 Anthropic 独特的工程文化：

- **Caffeinate：** 给 Mac 灌咖啡防止休眠，SIGKILL 后 5 分钟自动退出
- **Anti-Distillation：** 注入假工具定义，防止模型被蒸馏偷学
- **Undercover Mode：** 卧底模式，commit 禁止出现 AI 痕迹
- **荒诞加载动词：** 100+ 个搞笑动词（Boondoggling、Photosynthesizing、Moonwalking...）
- **Buddy System：** 确定性生成的电子宠物，有稀有度系统（legendary 仅 1%）
- **用户辱骂检测：** 检测到脏话后弹出反馈调查，邀请分享对话帮助改进

> 这些"没必要"的东西，让一个 AI Coding 的命令行工具有了人情味和可玩性。

## 七、对比与反思

### 与 OpenClaw 的对比

飞樰多次将 Claude Code 与 OpenClaw 对比：

| 维度 | Claude Code | OpenClaw |
|------|-------------|----------|
| 定位 | AI Coding Agent | 私人 AI 助理 Agent |
| 驱动文件 | CLAUDE.md（项目要求） | AGENT.md/SOUL.md/USER.md/TOOLS.md 等 |
| 记忆设计 | Memdir（User/Feedback/Project/Reference） | MEMORY.md + memory/日期.md |
| Hooks | 20+ 种事件类型 | 覆盖全生命周期 |
| 多 Agent | Subagent/Team/Coordinator | SubAgent/Session 通信 |

### 值得商榷的地方

毅宸的文章客观指出了几个值得商榷的设计：

1. **全局状态的广泛使用：** bootstrap/state.ts 包含 200+ 个字段
2. **权限系统的认知负担：** 8 种来源、5 种模式、3 种匹配模式
3. **BashTool 的复杂度集中：** 18 个文件、8 层安全检查

### 如果重新设计

1. 声明式权限策略（类似 OPA/Rego）
2. 渐进式上下文管理（按信息密度淘汰）
3. 工具结果的结构化存储
4. 模块化构建（工具/权限/UI 拆为独立包）

## 结语

四篇文章的共同结论是：**Claude Code 真正值得学的，不是某一段实现有多巧，而是它始终在认真回答同一个问题——当模型开始真的做事，系统准备在哪里把这些复杂度接住。**

对做 AI Agent 的团队来说，这比抄任何单点功能都更有价值。真正成熟的 Agent 系统，不是"模型更会做事"，而是"组织能把模型做事这件事，稳定地接进交付链路里"。
