---
description: "Sensitive-data compliance guard for private sessions — trusted-only model routing, egress tool denial, the gateway-stamped sensitive audit header, and suspension on server trust revocation — for users and maintainers composing or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-sensitive-policy

English | [中文](README.zh.md)

## Summary

Use this plugin to restrict private sessions to server-declared trusted model routes and deny egress tools, including external MCP tools. The gateway stamps allowed private requests with the sensitive audit header. Privacy follows explicit entry, trusted-provider use, server data classification, and fork lineage. Durable policy events and a Host-only projection preserve monotonic classification across restarts. Trust revocation cancels live private agents; logout cancels all live agents. Composed server skills receive the gated private lane.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

`sessionProjections` registers the Host-only `sensitive.policy` unit, reads classification from restored Session state, and advances it from committed events. The composition must provide this projection registry.

Each committed transition appends `sensitive/policy`. Before model inference or private tool execution, the plugin awaits the Session store durability checkpoint; a failed checkpoint blocks the operation. Restore replays those events before enforcing routes and tools. Logout cancels live Agents, and policy remains private across restarts and forks.

Add the plugin to a composition that also mounts `@deepseek-ai/dsh-gs-server` (the trust source — a declared injection) and the tool runtime; both ship in the gs-worker bundle. Private sessions are then enforced without further wiring.

### When to choose it

Choose it when sessions may carry sensitive business data and the deployment must prove that such traffic never leaves trusted model routes or egress tools. Avoid it when the composition has no gsclaw-server integration — the trust source is `gsServer`, and without it no provider route verifies as trusted — or when private sessions must keep unrestricted egress.

### Setting it up

Mount with defaults or override the egress list:

```yaml
- name: '@deepseek-ai/dsh-sensitive-policy'
  # config:
  #   egressTools: [bash, pwsh, web_fetch, web_search]
```

`egressTools` (default [`DEFAULT_EGRESS_TOOLS`](src/index.ts)) names the egress-capable tools an explicitly-private session loses. Entries are resolved against the live registry at restriction time, so naming an unregistered tool is valid; an explicit empty list lifts the egress lockdown tier while trusted-route enforcement and the audit header stay on. The audit header name (`x-gsclaw-sensitive`) and value (`1`) are protocol constants and are not configurable.

### What you get

- A `sensitivePolicy` service (`SensitivePolicyCore`) holding each session's policy state: `enterPrivate(sessionId)` locks a session to trusted-only egress (never undone), `stateOf`/`isPrivate` read it, and sensitivity (`unclassified` → `potential` → `sensitive`) only rises.
- At the model-call boundary (`llm/stream`): a private session's request on an untrusted route is refused with a terminal `session_provider_forbidden` error before the adapter runs; an allowed request's provider route is recorded, and the gsclaw model-gateway proxy stamps the `x-gsclaw-sensitive: 1` audit header on its wire request.
- At tool execution, every private session denies configured egress tools and all external `mcp__` tools, including vision. Scoped restrictions also hide configured tools; execution guards cover direct calls and PTC sub-dispatches.
- When the optional `gsServerSkillGate` service is composed (`@deepseek-ai/dsh-gs-server-skills`): every private session's agent — however the session became private — gets the gated trusted-only server-skill lane mounted into its scoped context (`agent.ctx`), at `agent/created` for an already-private session or mid-flight on the live agent when a transition turns the session private. Mounting is idempotent per session, a missing gate is a no-op, and the scoped registration unwinds with the agent, so trust-revocation cancellation tears the lane down with it.
- On `gs-server/trust-revoked`: every private session with observed model traffic is suspended (its live agent is cancelled with a `hook` cause) without re-judging the possibly stale cache. On `gs-server/client-config-changed`: each private session's recorded provider is re-judged against the fresh trust metadata, and newly untrusted ones suspend.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the plugin keys policy state to sessions and where each enforcement lives; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Enforce in the operation that makes it.** Denial happens inside the `llm/stream` waterfall and the monotonic `tools.guard` execution gate, not in UI filtering or schema omission, so direct and indirect (PTC sub-dispatch) callers cannot bypass it. The scoped `tools.restrict` on `agent/created` only trims the visible surface; the guard remains the enforcement.
- **Private sessions share execution limits.** Explicit and provider-endpoint causes record how privacy began. Both enforce trusted model routes and egress denial; an endpoint cause can upgrade to explicit and privacy never downgrades.
- **Fail closed.** Trust resolution treats an unknown provider, a missing models section, and an absent cached ClientConfig as `external`. Trust revocation suspends every private session with observed traffic rather than re-reading a cache that may predate the revocation.
- **The gate is mounted, not mirrored.** This package owns only the judgement of when a session is private; the gated lane itself (the scoped provider that re-checks `sensitivePolicy.isPrivate` per load and per execute) lives in `@deepseek-ai/dsh-gs-server-skills`, reached through the optional `gsServerSkillGate` service via `ctx.get` — never a declared injection — so compositions without it behave exactly as before.
- **Gateway-stamped audit header.** The wire emission lives in the model-gateway proxy, on the far side of an HTTP hop this package's requests cross: mirrored `llm-pi-ai` profiles switch on pi-ai's session-affinity emission, so each adapter request arrives at the loopback proxy with its session id; the proxy re-judges that session against this core (`isPrivate`) and stamps `x-gsclaw-sensitive: 1` upstream. Judgement and stamp read one core, so they cannot diverge, and the session id never leaves the loopback hop.

### How a request is judged

One `llm/stream` listener reads `options.sessionId`; requests without a session identity delegate untouched. It registers the session, applies the endpoint judgement (a standard session on a trusted route turns private), refuses private sessions on untrusted routes with a one-chunk `finish` error stream (the shape adapter failures normalize into, so the loop logs and routes it through its ordinary failure path), and otherwise records the provider and delegates. Because the endpoint judgement lands before dispatch, the gateway proxy audits even a session's first trusted-route request.

### How suspension is judged and executed

The core judges: `suspendedSessions(isTrusted)` returns private sessions whose recorded provider fails the predicate, sorted for determinism; a private session with no observed provider has nothing to suspend yet. The plugin executes: for each judged session it cancels the live agent (`ctx.agents.get(...)`), when one is mounted, with `{ kind: 'hook' }`. Suspended sessions stay private, so their next request is re-judged at the stream boundary.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `name`/`inject`/`Config`/`apply`, the `llm/stream` wrapper, the egress guard, scope restriction, skill-lane mounting, suspension listeners |
| [`src/core.ts`](src/core.ts) | `SensitivePolicyCore` state machine: monotonic transitions, subscription, suspension judging; declares `Context.sensitivePolicy` |
| [`src/trust.ts`](src/trust.ts) | Trust resolution (fail-closed) and the audit-header protocol constants |
| [`src/types.ts`](src/types.ts) | Session policy state and transition types; the consumer-side `GsServerSkillGateFace` |
| — | No runtime invariant companion is published: enforcement is synchronous inside the owning waterfalls and gates, and the package owns no durable state relation that independent observations could diverge from. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the enforcement seams to the trust source and the guard family.

- [Tools subsystem reference](../../../docs/subsystems/tools.md) — the `tools.guard` monotonic gate and restriction semantics this package enforces through.
- [Cordis primer](../../../docs/cordis-primer.md) — waterfall semantics behind the `llm/stream` wrapper.
- [gs-server client](../../api/gs-server/README.md) — the `gsServer` service, its ClientConfig trust metadata, and the `gs-server/*` events this package consumes.
- [gsclaw model-gateway adapter](../../llm/llm-gs-gateway/README.md) — the loopback proxy that reads this core's privacy judgement and stamps the audit header on the wire.
- [guard group map](../README.md) — the sibling guard packages.

-----

<a id="model-experience"></a>
## Model Experience

### Conditional tool result

#### What the model sees

This plugin adds no prompt or schema. If a private session calls an egress-listed tool, the model receives an error result reading `Error: tool "<name>" is unavailable in a private session: sensitive-data policy restricts egress-capable tools`; every other result passes through unchanged.

#### Token effect

Zero tokens on allowed calls. A denial adds one small retained error result and prevents the denied tool's output from entering context.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

### Conditional model request

#### What the model sees

A private session's request on an untrusted provider route is refused before dispatch as a terminal `session_provider_forbidden` failure; the request never reaches the provider, so the model produces no content for it and the turn surfaces the structured failure instead.

#### Token effect

A refused request sends zero tokens to the provider; allowed requests are byte-identical to an unguarded composition (the audit header is model-hidden transport metadata).

#### KV Cache effect

No change: request content is untouched, so prefix reuse behaves exactly as without the plugin.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are durable consumer gaps of the gs-worker migration, not a task backlog.

- **Manual private-session UI is deferred.** Server `agent.dataClass` values `sensitive` and `confidential`, trusted provider use, or a host call to `enterPrivate` establish privacy. There is no separate manual toggle in the shipped interface.
- **Server-skill gating is split across two packages.** This package mounts the gated lane into private agents; the lane itself and the standard-session guard against gated skills ship with `@deepseek-ai/dsh-gs-server-skills`. The desktop lane's admitted-revision pinning (`admit-skill`) is deliberately not ported: this core no-ops the transition, and the lane's plain `isPrivate` re-check per load and per execute is the agreed gate.
- **Auto-switch to a trusted route on a gated invocation is deferred.** The desktop enforcer switched an untrusted-route session onto the default trusted route before mounting the lane; that needs a public `sessionController.selectModel` equivalent this repository does not have yet, so a gated invocation from an untrusted session is simply refused.
- **`-vision` twin trust inheritance is dropped.** The desktop derived trust for the vision-router's `-vision` provider twins; that router is not in this repository, so twin resolution has no consumer here.
- **Suspension is cooperative.** Cancellation aborts the live agent's activity; the session stays private and every later request is re-judged, but an operation that ignores its abort signal is not hard-killed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked documentation.

Migrated from the desktop product's `sensitive-policy-core.ts` / `sensitive-policy-enforcer.ts` (dsh-desktop, read-only). The core is created by the plugin itself, `gsServer` is a declared injection, and historical policy events are replayed on resume.

</details>
