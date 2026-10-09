---
description: "gs-worker untrusted-model risk disclosure: model-list locks authorize selection through an electronic signature dialog and provide archived-PDF download."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-risk-gs

English | [中文](README.zh.md)

## Summary

Untrusted models show a lock at the right of their model-list row; signed models show a neutral open lock, and trusted models show no lock. Choosing an unsigned model opens the server disclosure before changing the session model. The user reads the text, acknowledges it, and signs by hand; selection proceeds only after the server returns a consent id. Cancellation or signing failure preserves the previous model. The server resolves the name and receiving email from the authenticated account and employee directory; the client has no identity fields and submits none. Signed receipts offer archived-PDF download. Requests use the Host loopback routes; the access token remains in the Host.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The GS browser composition mounts this plugin by name. It registers the model-row lock in `model.option.accessory` and hosts the requested-model dialog in `conversation.input.activity`, with no composer icon. A `modelDirectories.registerSelectionGuard` registration waits for consent before the model selector or `/model` command submits a choice.

The disclosure names the requested model; the session keeps its previous model until authorization succeeds. Rows read server status each time the menu opens and retry on window focus. Selecting a row reads the current disclosure and signing state again.

<a id="understand-the-implementation"></a>
## Understand the implementation

The lock renders after the server answers `required: true` or a status request fails. A failure retains the last disclosure, shows an unavailable-state title, and offers a retry action in the dialog; signing remains disabled until a fresh status succeeds. A confirmed trusted route hides the entry. An unsigned route colors the lock as a warning; a route with an archived consent shows the neutral lock. Signing names the revision the status returned; a revision conflict reloads the current text and asks for a fresh signature. Handwriting uploads as normalized [0,1] point strokes, so the server renders the PDF at its own resolution. The PDF download decodes base64 into a Blob and clicks a temporary `a[download]` anchor.

No runtime invariant companion is published because this plugin renders browser chrome and owns no independently observed runtime state relation.

<a id="model-experience"></a>
## Model Experience

None, as the disclosure dialog only mediates between the user and the server; model requests are unchanged.

#### KV Cache effect

None; this package does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The server rejects signing when the account has no registered name or employee email, and asks an administrator to complete the record.
- The wire types are declared locally (`src/client/contract.ts`) as a mirror of the `@deepseek-ai/dsh-gs-server` export surface because that package's compiler face is Host-only.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The disclosure uses the repository slot, locale, and shared Modal APIs. The authenticated server account determines signer identity and mail recipients.

</details>
