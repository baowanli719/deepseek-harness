---
description: "gs-worker account launcher for the sidebar footer."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-account-gs

English | [中文](README.zh.md)

## Summary

The sidebar footer shows the gsclaw account name and opens a menu for settings, skills, about, and logout. Its launcher registers at priority -10 to shadow the standard desktop account launcher without a single-slot registration conflict. Its account reads use Host-owned same-origin routes; access tokens never enter the renderer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The avatar and identity form one clickable account row without a separate expand arrow. Hover and the expanded menu use the same background feedback; the button retains its localized accessibility name, menu semantics, and keyboard focus outline in both sidebar widths.

The Skills and About menu entries use their matching navigation icons. About presents the product mark through a brand slot, localized product information, office capabilities, enterprise service ownership, and the client build version.

<a id="understand-the-implementation"></a>
## Understand the implementation

The client uses Host routes and UI slot registrations; signing out clears its account view.

No runtime invariant companion is published because this plugin renders browser chrome and owns no independently observed runtime state relation.

<a id="model-experience"></a>
## Model Experience

None, as the account menu only renders browser identity and navigation.

#### KV Cache effect

None; this package does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Account information loads when the launcher mounts; a server-side identity change needs a reload.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
