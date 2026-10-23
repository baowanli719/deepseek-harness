---
description: "gs-worker server-pushed notice banner: polls the gs-server notice loopback route and shows the active notice at the top of the conversation content area until it expires or the reader dismisses it."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-notice-gs

English | [中文](README.zh.md)

## Summary

The banner shows the server's current notice at the top of the conversation content area, with or without an open session. It polls the Host's gs-server notice loopback route on a configurable cadence; the access token remains in the Host. Optional `startAt`/`endAt` ISO fields bound the display window, and a non-dismissible notice offers no close control. Dismissal persists per browser in localStorage and lifts automatically when the notice text or start time changes. A failed poll keeps the previous banner rather than flickering it away.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The GS browser composition mounts this plugin by name. It registers the banner in `conversation.notice`, which renders above the session views whether or not a session is selected; with no active notice the entry renders null. `refreshIntervalSeconds` in the cordis.yml row sets the poll cadence (default 300 seconds); a non-positive or non-finite value fails the load.

The server answers `{notice: null}` to hide the banner. Absent scheduling fields show the notice immediately and keep it until removed or dismissed; an unparseable schedule field imposes no limit rather than hiding the notice.

<a id="understand-the-implementation"></a>
## Understand the implementation

A root-owned controller holds the latest fetched view and the reader's dismissal fingerprint in one snapshot store; the banner subscribes to it and derives visibility through a pure selector over the store snapshot and the current time. The dismissal fingerprint joins the notice text and start time, so an edited notice re-appears for readers who closed the earlier one. The fingerprint persists under one localStorage key; storage denial degrades dismissal to the current session only. The refresh timer runs inside a cordis effect, so unloading the plugin clears the interval and removes the slot entry.

No runtime invariant companion is published because this plugin renders browser chrome and owns no independently observed runtime state relation.

<a id="model-experience"></a>
## Model Experience

None, as the banner only mediates between the user and the server; model requests are unchanged.

#### KV Cache effect

None; this package does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Dismissal is per browser and per profile: it lives in localStorage, not in the server account, so a reader who dismisses a notice on one device sees it on another.
- The wire types are declared locally (`src/client/contract.ts`) as a mirror of the `@deepseek-ai/dsh-gs-server` export surface because that package's compiler face is Host-only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The banner uses the repository slot, locale, and snapshot-store APIs and mirrors the ui-model-risk-gs loopback pattern: same-origin relative fetch with `credentials: 'same-origin'`, `redirect: 'error'`, and `cache: 'no-store'`, plus a local wire validator.

</details>
