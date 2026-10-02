---
description: "Server-executed gsclaw skill bridges and administrator-controlled local skill trust for the gs-worker composition — for users and maintainers composing or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-gs-server-skills

English | [中文](README.zh.md)

Server-executed skill bridges (`run_data_query` / `run_mcp_skill` tools executed by gsclaw-server) and administrator-controlled local skill trust: admins can mark local skills trusted-only by name + SHA-256.

## Summary

This plugin lists delivered server skills in `ctx.skills` and forwards data-query and server-MCP execution through the authenticated GS bridge. Client-runtime bundles are fetched under current authorization and cached by endpoint, account, skill, and version. Loaded remote definitions describe their query templates or MCP tools. Live administrator switches, account preferences, and privacy policy govern discovery and execution. A local provider applies creation permissions and administrator name-plus-SHA-256 trust restrictions to managed and user-home skills.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Gated definitions recheck login, global and per-skill controls, preferences, session generation, and privacy on every load, including warm entries. Session-ended events clear remote state. Client bundles are fetched under current authorization on every load and cached in endpoint-and-account-specific directories; identical names and versions cannot reuse another account’s files.

Mount it after the skill registry, the tool registry, and `@deepseek-ai/dsh-gs-server` (the plugin injects `skills`, `tools`, and `gsServer`).

| Field | Default | Meaning |
|---|---|---|
| `executeTimeoutMs` | `120000` | Client-side ceiling of one server skill execute call |
| `bundleCacheRoot` | `$DSH_HOME/gs-skills/bundles` | Versioned cache root for `client` runtime skill bundles |
| `localSkillManagedRoot` | `$DSH_HOME/local-skills` | Application-managed local skill root, scanned first |
| `localSkillHomeRoot` | `~/.skills` | User-home local skill root, scanned second |

### What the model gets

- **Server skills in the catalog.** Delivered `data-query` / `server-mcp` skills list and load like local skills; the loaded body ends with a `## Available query templates (call via run_data_query)` or `## Available tools (call via run_mcp_skill)` section rendered from the server definition, naming the exact templates/tools and parameter shapes the model may use.
- **Client skills as directory bundles.** Delivered `client` skills list and load like local skills; the loaded body is the bundle's `SKILL.md` and its relative resources resolve against the materialized cache directory.
- **Bridge tools.** While the effective catalog holds an executable skill of a runtime type, the model sees that type's bridge tool and calls it with the skill name plus the declared template/tool name and arguments; the result is the server's text, with a suffix note when the server truncated it.
- **Gated skills stay visible but silent on the standard lane.** Server skills flagged `trusted-only` and local skills matching a name+SHA-256 restriction list as non-invocable entries; they never enter the standard model catalog, never load, and never resolve through the standard bridge call.
- **Live local permissions.** Local discovery checks authentication and `allowLocalSkillCreate` after scanning; body loading checks both before and after reading the file. A revocation during disk I/O refuses the result. Configuration pushes invalidate cached discovery, while the body loader also refuses stale candidates independently.
- **The gated trusted-only lane.** The plugin provides the `gsServerSkillGate` service. `@deepseek-ai/dsh-sensitive-policy` mounts it into every private session's agent scope (`mountPrivateLane(agent.ctx)`); the scoped lane lists the catalog's retained gated entries as invocable and re-checks `sensitivePolicy.isPrivate(sessionId)` on every definition load. A gated execute requires a private calling session, carries the session id in the request body, and sends the `x-gsclaw-sensitive: 1` audit header; a catalog holding only gated entries still registers the bridge tools. Without the `sensitivePolicy` service the lane never resolves gated content.

### Observable success and failures

The preference service reports each skill's runtime type and why it cannot run: `runtime-unsupported` or `trusted-session-required` (the skill runs only inside a private trusted-model session; the session-less settings view reports it unavailable). A user's disabled preference is independent of execution support. Unsupported and trusted-only skills retain their execution gates; reporting a reason does not enable them.

Calling a bridge tool for a skill absent from the effective catalog fails with `skill "<name>" is not an available <runtimeType> skill in the current catalog`. Calling a gated skill outside a private session fails with `skill "<name>" requires a trusted session and cannot execute in the current session`. A `definition_changed` failure invalidates the catalog and tells the model to reload the skill and reconstruct the call. Policy-class refusals invalidate the catalog without retry guidance. Sync or definition fetch failures keep the last good catalog and report incomplete discovery so later turns retry.

<a id="model-experience"></a>
## Model Experience

### Bridge tool schema

#### What the model sees

The model sees the generated [`run_data_query` and `run_mcp_skill` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-gs-server-skills) only while the server advertises the matching `skillExecution` type and the effective catalog holds an executable skill of that type — retained gated trusted-only entries count, so a gated-only catalog keeps the bridge visible for private sessions while the per-call private check refuses everyone else; both disappear when the catalog empties, the session signs out, or the master `SKILLs` switch turns off.

#### Token effect

Fixed schema cost per request per visible bridge tool; zero while hidden.

#### KV Cache effect

Prefix-stable while the catalog keeps the tool registered; visibility flips invalidate reuse from the tool schemas on.

### Bridge tool result

#### What the model sees

A successful call renders the server's joined text blocks, plus `[The server truncated this result; narrow the parameters if more rows are needed.]` when the server flagged truncation. Failure text names the machine code and, when present, the server traceId.

#### Token effect

Result tokens are data-dependent; only a visible executed call adds them.

#### KV Cache effect

A tool result appends after the reusable request prefix and never invalidates existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Migration scope from `dsh-plugin-desktop` (gs-worker): the following lanes are deliberately cut or deferred.

- **Narrow `gsServer` face.** The package consumes `ctx.gsServer` through the structural `GsServerBridge`/`GsSkillConfigView` subset in `src/types.ts` (token, authenticated fetch, ClientConfig subset) rather than the full `GsServer` class; the class is assignable, and tests substitute a mock. If the upstream service contract changes, this face must be re-checked field by field.
- **Legacy `/api/skills` catalog fallback is not migrated.** Servers without the `skillExecution` meta capability receive an empty catalog; the old whole-catalog legacy listing is deferred. The `client` runtime bundle channel itself is migrated: on capable servers the provider fetches the bundle from `GET /api/skills/:name/files`, `SkillBundleCache` validates and safely materializes it into a versioned on-disk cache, and the skill loads from the materialized directory.
- **The gated trusted-only lane is migrated.** Server `trusted-only` entries are retained in the catalog's `gated` list and released inside private sessions through the `gsServerSkillGate` service (see [What the model gets](#what-the-model-gets)); `@deepseek-ai/dsh-sensitive-policy` owns when a session is private. The desktop lane's admitted-revision pinning (`admit-skill`) is deliberately not ported: the new policy core no-ops it, and a plain `isPrivate` re-check per load and per execute is the agreed gate. Restricted local content stays non-invocable on every lane.
- **Explicit private-session entry UI is not migrated.** No shipped surface calls `sensitivePolicy.enterPrivate`; a session becomes private only on a trusted-provider route or by a host calling the core programmatically (recorded in the `@deepseek-ai/dsh-sensitive-policy` README).
- **Auto-switch to a trusted route on a gated invocation is deferred.** The desktop enforcer switched an untrusted-route session onto the default trusted route before mounting the lane; that needs a public model-selection API this repository does not have yet, so a gated invocation from a non-private session is simply refused.
- **Per-user skill enable/disable preferences are preserved.** The provider reads the previous gs-worker account-hashed JSON files and applies the current account's switches before publishing skills.
- **Installed-set reporting and review uploads are not migrated.** `POST /api/skills/report-installed` and its review-content upload flow stayed behind; they depend on the desktop settings/audit surface.
- **Settings-page state shares are narrower.** The legacy `gsSkillSync` tracker is replaced by the current catalog and preference service; local create and refresh are provided through the Host routes.
- **No live filesystem watch for local roots.** The `fs/observed` mutation subscription of the desktop provider is cut; local skill changes are picked up on the next registry invalidation (e.g. a server config push).

**Runtime invariant:** No companion is published because catalog gating and local trust checks are synchronous inside the registry and provider operations; the package owns no durable relation independent observations could diverge from.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context; shipped behavior lives in the sections above and the package code.

Migrated from the desktop product's server-skill and local-skill providers (dsh-desktop, read-only). Deliberate adaptations: the plugin consumes `ctx.gsServer` through the structural subset in `src/types.ts` so tests substitute a mock, and both local roots are explicit Config fields rather than launcher-resolved paths.

</details>
