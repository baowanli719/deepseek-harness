---
description: "gs-worker brand occupants for the sidebar and conversation hero."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-gs

English | [中文](README.zh.md)

## Summary

This browser plugin shows the gs-worker logo and reads the effective brand name and headline from the Host's same-origin `/api/gs-server/brand` route. The Host resolves cloud updates, cached values, and defaults.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The product About section also displays this transparent logo through its brand mark slot.

<a id="understand-the-implementation"></a>
## Understand the implementation

The client reads Host-owned content through same-origin requests.

No runtime invariant companion is published because this plugin renders browser chrome and owns no independently observed runtime state relation.

<a id="model-experience"></a>
## Model Experience

None, as the brand occupants only render browser chrome.

#### KV Cache effect

None; this package does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The brand is read when occupants mount; cloud changes appear after the next reload.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
