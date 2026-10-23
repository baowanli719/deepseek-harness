---
description: "gs-worker server-configured scenario shortcuts below the new-task hero composer: insert configured skill commands into the current draft without submitting it."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-scenarios-gs

English | [中文](README.zh.md)

## Summary

Scenario buttons below the composer insert a skill command at the current caret or selection. The server can replace the four client defaults, hide individual rows, or hide the whole list. Insertion preserves the draft and reference chips, adds only necessary neighboring whitespace, restores editor focus, and never submits automatically. Failed configuration polls retain the last valid list. The pill-shaped buttons sit visibly separated below the composer card and lead each label with an outline icon mapped from the skill: search for `zhidu-knowledge`, list-pen for `gs-research-summary`, database for `juyuan-data`, sparkle for `miaoxiang-data`, and a generic skill glyph for any other server-defined skill.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The GS browser composition mounts this plugin by name in `conversation.composer.shortcuts`, the first-screen slot below the new-task hero composer; a started task's bottom composer does not dispatch the slot, so the buttons appear only on the hero screen. `refreshIntervalSeconds` sets the poll cadence (default 300 seconds); a non-positive or non-finite value fails the load. The buttons follow the owner's `locked` state and cancel mousedown focus movement.

The route `GET api/gs-server/scenario-shortcuts` returns a `scenarioShortcuts` field. An absent or undefined field selects four localized defaults: 制度库查询→`zhidu-knowledge`, 研报分析→`gs-research-summary`, 聚源金融数据→`juyuan-data`, and 东财金融数据→`miaoxiang-data`. Null or `{enabled:false,...}` hides the list. Otherwise `items` supplies non-blank stable `id` and display `label` strings, plus a `skill` matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`; an item with `enabled:false` is hidden. Server labels render as data and are not translated.

<a id="understand-the-implementation"></a>
## Understand the implementation

The `gs-scenarios` ResourceProtocolMap provider owns the fixed `dsh-resource://gs-scenarios/shortcuts` address. The plugin pins that address for its own effect lifetime, so the stream opens at plugin startup and remains live while the hero shortcut component mounts and unmounts; returning to the first screen reads the retained value without restarting the request or flickering. The provider's first `ok` frame is `undefined` (the four defaults), followed by sequential polls through the token-free Host loopback route. Strict response validation rejects malformed envelopes, items, and duplicate ids. Failure frames leave the last successful value in the resource registry. The component reads the standard `useResource` hook as an additional holder; its release leaves the pinned stream open. Unloading the plugin aborts any in-flight fetch or delay, drops late results, and removes both the provider and slot entry.

On click, the component captures the current revision-guarded selection and maps both detect-coordinate edges into clipboard coordinates with the reference occurrences and optional leading command token; each chip occupies one detect character but its full text length in the clipboard draft. It then calls only `inputActions.insertText`. A leading space is added only when the left adjacent character is non-whitespace. A trailing space is added whenever the right side has no existing whitespace, including at the end of the draft; existing right whitespace is not duplicated. The owner refocuses the composer only after insertion succeeds; rejection leaves focus and content ownership with the editor.

No runtime invariant companion is published because this plugin owns no independently observed runtime state relation.

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

Nothing directly. The package only calls `inputActions.insertText` on the unsent draft; the ordinary user-submission path owns any later model-visible command.

#### Token effect

Zero direct token effect. This package neither submits a message nor assembles a provider request.

#### KV Cache effect

Independent. No model request or cache prefix is created, replaced, or invalidated by this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The wire fields are declared locally (`src/client/contract.ts`) as a mirror of the `@deepseek-ai/dsh-gs-server` configuration because that package's compiler face is Host-only; changes must keep both declarations aligned.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
