# /review — Review a Pull Request

> Claude Code 内置 skill。源码位于 `claude.exe` 二进制中，是一个简单的 prompt 模板。

---

## 1. 元信息

| 字段 | 值 |
|---|---|
| `name` | `review` |
| `description` | Review a pull request |
| `progressMessage` | reviewing pull request |
| `source` | builtin |
| `userInvocable` | true |

---

## 2. 入参

skill 通过 `getPromptForCommand(H)` 接收一个参数 `H`，即用户在 `/review` 后面输入的内容（通常是 PR 编号）。

| 调用方式 | `H` 的值 |
|---|---|
| `/review` | 空字符串 |
| `/review 1234` | `"1234"` |
| `/review 任意文本` | `"任意文本"` |

`H` 会被原样替换到 prompt 末尾的 `${H}` 处。

---

## 3. 出参

skill 调用后立即返回一个 prompt（type: `text`），交给模型执行。模型最终输出的是 markdown 格式的代码评审报告。

---

## 4. 完整 Prompt 原文

```
You are an expert code reviewer. Follow these steps:
1. If no PR number is provided in the args, run `gh pr list` to show open PRs
2. If a PR number is provided, run `gh pr view <number>` to get PR details
3. Run `gh pr diff <number>` to get the diff
4. Analyze the changes and provide a thorough code review that includes:
   - Overview of what the PR does
   - Analysis of code quality and style
   - Specific suggestions for improvements
   - Any potential issues or risks
Keep your review concise but thorough. Focus on:
- Code correctness
- Following project conventions
- Performance implications
- Test coverage
- Security considerations
Format your review with clear sections and bullet points.
PR number: ${H}
```

---

## 5. 动态变量

| 变量 | 来源 | 说明 |
|---|---|---|
| `${H}` | 用户在 `/review` 后输入的 args | 直接拼到 `PR number:` 后；为空时模型会先跑 `gh pr list` 列出待选 PR |

除此之外没有其他动态变量——整段 prompt 都是常量字符串。

---

## 6. 行为流程

1. 用户输入 `/review` 或 `/review <PR编号>`
2. 模型执行 `gh pr list`（无参时）或 `gh pr view <num>` + `gh pr diff <num>`
3. 模型输出包含 6 个维度的评审报告：
   - PR 做了什么
   - 代码质量和风格
   - 具体改进建议
   - 潜在问题或风险
   - 性能影响
   - 测试覆盖
   - 安全考量
