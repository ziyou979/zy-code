# 代码审查命令

`/review` 和 `/code-review` 是同一命令。默认只在当前会话报告问题，不修改文件、不发布 PR 评论，也不会跳过草稿或自动化 PR。

```text
/review                         审查暂存、未暂存和未跟踪的改动
/review origin/main             审查相对分支的已提交改动
/review --base origin/main      显式指定基准分支，排除未提交改动
/review --commit abc123         审查单次提交
/review --pr 123                审查 PR
/review src/services/auth       审查指定路径下的未提交改动
/review "path with spaces"      带空格的目标需要引号
/review --fix                   审查后应用已验证的修复
/review --pr 123 --comment      审查后发布 PR 评审意见
```

只能指定一个目标。纯数字或 `#编号` 按 PR 解释；有歧义时用 `--base`、`--commit`、`--pr`。目标解析失败时停止，不自动改审其他范围。

`--fix` 只在本地 checkout 与审查目标匹配时应用修复。`--comment` 只适用于 PR，发布前重新检查 PR head，避免发布过时结论。目标识别、diff 收集和审查由模型调用工具完成。

`/simplify [目标]` 保留独立的质量清理流程：检查复用、简化、效率和抽象层次并应用修复。目标可以是 PR、分支或路径；没有目标时按现有流程收集分支及工作区改动。

`/security-review` 保留独立的安全审查流程，不接受目标参数。范围是 `git diff origin/HEAD...`，即当前分支相对远端默认分支分叉点的已提交改动，不包含未提交改动。
