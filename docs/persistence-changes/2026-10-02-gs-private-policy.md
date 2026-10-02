---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-gs-private-policy

English | [中文](2026-10-02-gs-private-policy.zh.md)

## Summary

Declares durable sensitive/policy events for monotonic private-session and sensitivity transitions. Adds a host-only privacy projection checkpoint and the attribution-only gs-prompt-language source kind.

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
## Compatibility

Existing Session records remain valid. The new required event carries policy state rather than model content. Current readers replay it before routing sensitive inference or tools; older readers without this event refuse affected Sessions rather than dropping privacy enforcement. The event is additive under the Session format compatibility rules. The projection cache is additive and rebuilt from recorded policy events. Prompt-language attribution adds no behavior under the attribution-only compatibility rule.

<a id="verification"></a>
## Verification

The GS agent-policy Loader integration test writes confidential policy through the real JSONL backend, reopens the durable Session, and verifies restored private classification. Sensitive-policy tests block inference until the checkpoint completes and refuse external routes after replay.

<a id="dev-note"></a>
## Dev Note

None.
