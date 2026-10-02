---
description: "gs-worker Skills settings page and local skill creation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skills-gs

English | [中文](README.zh.md)

## Summary

This page lists server and local skills available to the current account, toggles server skill activation, and creates a local skill when the server permits local creation. The Host owns discovery, account-scoped preferences, and permission enforcement.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Unavailable server skills display the Host's specific cause: client execution has not been migrated, a trusted model session has not been connected, or the execution method is unsupported. Trusted-only skills also carry a trusted-model label. A supported skill switched off by the user instead explains that enabling it makes it callable. Unknown or older responses keep the generic unavailable message.

Local creation always shows its permission status. When the administrator disables creation, the form stays visible with gray disabled controls and guidance to contact the administrator. Signed-out accounts and failed permission refreshes cannot submit the form.

## Build and verify

The settings page is served from `lib/client.js`, independently of the Host's `lib/index.js`. For a focused rebuild, run `pnpm exec tsc -b packages/client/ui-skills-gs` at the repository root, then run `pnpm exec tsdown --config tsdown.config.ts --env.DSH_BUILD_FACE client` in this package. Confirm that the build emits `lib/client.js`; a successful Host-only build does not update the page. When replacing an installed bundle, verify the browser artifact contains the new reason fields and check the page after restarting the client.

<a id="understand-the-implementation"></a>
## Understand the implementation

The client reads Host-owned content through same-origin requests.

No runtime invariant companion is published because this plugin renders browser chrome and owns no independently observed runtime state relation.

<a id="model-experience"></a>
## Model Experience

Indirectly, through Host-owned skill preferences and registry discovery after the user changes a skill.

#### KV Cache effect

The resulting skill catalog can change the model's tool and skill context on a later turn.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The settings page has no model-session context; trusted-only skills require a trusted private session to execute.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
