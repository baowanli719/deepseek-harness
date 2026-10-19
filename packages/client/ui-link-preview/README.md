---
description: "Plugin registration and right Sidebar text previews for authenticated source links."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-link-preview

English | [中文](README.zh.md)

## Summary

This plugin opens application-owned source links in a shared right Sidebar text reader. Authentication-specific plugins recognize their URLs and supply reads through their Host adapters; the browser never needs gateway credentials.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The Web bundle mounts this plugin. Providers inject `linkPreviews` and register `{ name, accepts, read }` through `ctx.effect`. Registration returns a disposer; duplicate names fail. The first matching registration owns a click. Unmatched links retain Chat's browser preference. Modified clicks retain native anchor behavior.

`accepts(URL)` is synchronous. `read(url, signal)` returns `LinkPreviewResult`: `ok` with `{ title, content, truncated }`, or `unauthorized`, `forbidden`, `source-mismatch`, `not-found`, `unavailable`, or `failed`. The provider owns wire validation and its authenticated Host route. The Host independently validates destination origins and paths before attaching credentials and refuses redirects. [GS Skills](../ui-skills-gs/README.md) is the shipped provider.

The reader renders Markdown headings, tables, lists, blockquotes, reference links, and footnotes through the shared renderer; raw HTML remains literal text. A raw-text view preserves the complete returned content, including malformed-format fallbacks. Selecting a passage enables **Quote selection**, which inserts the selection and a source-title link at the conversation composer’s saved selection without sending. Busy submission disables quoting; insertion outcomes appear in a shared toast. The reader shows truncation and authentication failures, supports retry and the Sidebar refresh command, and aborts obsolete reads. Provider name and URL travel in transient tab navigation; the reader does not persist source text or credentials. Explicit quotes follow the ordinary draft and user-message lifecycle.

## Understand the implementation

`chat/open-link` offers a selected HTTP(S) URL to plugins before normal navigation. This plugin resolves the provider and opens its reader in the originating Session. Provider registration changes invalidate existing readers; removed providers cannot perform new reads.

No runtime invariant companion is published: registrations and read state have one owner, with no independent observation to reconcile. Disposal and stale asynchronous completion are covered by behavior tests.

## Model Experience

None, as source reads add no model context and explicit quotes use the ordinary composer and user-message path.

#### KV Cache effect

Reading alone does not alter model requests. A sent quote enters the ordinary user-message context.

## Known Limitations and Deferred Work

- Restoring the Sidebar layout does not restore source navigation parameters; reopen the source link after restarting the application.
- The reader supports Markdown and plain text. A provider must normalize PDF, Office, or other binary sources itself. It does not grant access to arbitrary websites or supply credentials outside the provider's Host adapter. After a final 401, the reader asks the user to sign in again; the authentication provider owns its login UI.

### Dev Note

The provider registry and reader are browser-only. Host adapters own credentials and wire validation.
