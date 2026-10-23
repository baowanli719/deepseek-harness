---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-gs-private-policy

English | [中文](2026-10-02-gs-private-policy.zh.md)

## Summary

Adds enterprise privacy events and message attribution after the upstream working-directory changes.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The integrated writer retains Session format v4. Existing upstream message variants and working-directory attribution remain valid. Enterprise privacy events are required on read, so a reader without their declarations refuses the log rather than silently dropping privacy policy. The enterprise additions do not change the interpretation of existing events. No committed physical format generation is rewritten or removed.

<a id="verification"></a>
## Verification

The targeted regression run passed the two Loader tests in packages/bundle/gs-app/tests/agent-policy.spec.ts and the three tests in packages/bundle/gs-app/tests/skill-policy.spec.ts, including durable private-policy reload and live permission enforcement. The 177 enterprise account, model-gateway and server-skill tests also passed. The integrated Host and Client builds and aggregate type checks passed.

<a id="dev-note"></a>
## Dev Note

None.
