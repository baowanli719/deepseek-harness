---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-02-gs-private-policy

[English](2026-10-02-gs-private-policy.md) | 中文

## 概述

在上游工作目录变更之后添加企业私密事件与消息归属。

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
    previous: "2026-10-13-user-rpc-principal"
    after: "957bd5d634227ac951c8a96e92976eb870ffa14f9b8a511d09b5f9081ae1c0a3"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "d0ad8a172d9e4387016d241d4b29a6f6b1ebafc5946e3e238e73e87327ce856a"
    decision: same-version
  - root: "event:sensitive/policy"
    previous: null
    after: "ed623394e92e633e50dca80b18bd1ffce65fdd67df0e001bd722239dcb3e27c0"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "9ecfd89b120c0752a9195a0684f5fad9f6680cd86a11dcefa5929a96949f75a6"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "964ddacc706427a8095987a979895a8f71a287cebfab5db440410bf3fcd166b2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

合并后的写入方保留 Session v4 格式。已有上游消息变体与工作目录归属仍然有效。企业私密事件必须在读取时被识别，因此缺少对应声明的读取方会拒绝日志，不会静默丢弃私密策略。企业新增内容不改变已有事件的解释方式。不重写或删除任何已提交的物理格式代际。

<a id="verification"></a>
## 验证

专项回归中，packages/bundle/gs-app/tests/agent-policy.spec.ts 的两个 Loader 测试和 packages/bundle/gs-app/tests/skill-policy.spec.ts 的三个测试通过，覆盖持久化私密策略重载与实时权限执行。企业账户、模型网关和服务端技能的 177 个测试也通过。合并后的 Host、Client 构建及汇总类型检查通过。

<a id="dev-note"></a>
## 开发备注

无。
