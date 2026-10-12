---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-02-gs-private-policy

[English](2026-10-02-gs-private-policy.md) | 中文

## 概述

声明持久化 sensitive/policy 事件，记录单调的私密会话与敏感度转变。新增仅供 Host 使用的私密策略投影检查点，以及仅承载来源归属的 gs-prompt-language 类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-gs-private-policy
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "d7af04d127b483d95eff249da3560886ed9837780f721cc964239025e0047c35"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "91c57bd990e22c8d8b5dd7fd6b9816497c59b8ac25b59cffc0e8e6abb62d1d7d"
    decision: same-version
  - root: "event:sensitive/policy"
    previous: null
    after: "ed623394e92e633e50dca80b18bd1ffce65fdd67df0e001bd722239dcb3e27c0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "f71893264d39ff22ddf187ed3388bf3d2bd7cae19aafd9c48fc5da0720b3484d"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "96684d4c5fa2b14b9b7b6c1a1e04bc18ee8e07b8d7a20ce0c5898cf8d5b520ef"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有会话记录保持有效。新增必需事件承载策略状态，不承载模型内容。当前读取方先重放该状态，再执行敏感推理与工具路由；不认识该事件的旧读取方拒绝受影响的会话，避免丢弃私密限制。该事件遵守会话格式的增量兼容规则。投影缓存为增量新增，可由已有策略事件重建。提示语言来源归属不承载新的行为，沿用仅承载来源归属的兼容规则。

<a id="verification"></a>
## 验证

GS agent-policy 的 Loader 集成测试经真实 JSONL 后端写入机密策略，重新打开持久会话后验证私密分类。sensitive-policy 测试验证检查点完成前推理被阻止，并在重放后拒绝外部路由。

<a id="dev-note"></a>
## 开发备注

无。
