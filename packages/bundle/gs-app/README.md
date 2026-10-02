---
description: "The gs-worker (国盛办公AI) product bundle over dsh-base + dsh-web-app — gsclaw-server integration, model-gateway adapter, sensitive-data compliance, server skills, vision channel, and the office-assistant persona — for users composing or debugging the gs-desktop profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-gs-app

English | [中文](README.zh.md)

## Summary

The `agent-policy` plugin limits sandbox and approval resolution using live server Agent configuration. Local presets and approved escalations cannot exceed it. Missing authentication or plan-only policy denies tools; read-only and tool-mediated policies cap filesystem access at read-only. Sensitive and confidential classifications enter durable privacy. The GS composition disables external session-feedback telemetry and its feedback controls.

The gs-worker (国盛办公AI) product bundle: a patch layer over `dsh-base` + `dsh-web-app` wiring gsclaw-server integration, the model-gateway adapter, sensitive-data compliance, server skills, the vision channel, and the 国盛证券办公助理 persona. It composes into the shipped `gs-desktop` profile template (`@deepseek-ai/dsh-app-boot`): `pnpm dsh --profile gs-desktop`.

## Table of Contents

- [What the patch does](#what-the-patch-does)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-the-patch-does"></a>
## What the patch does

`cordis.patch.yml` applies after the base and Web bundle layers:

- **Persona and language** — the `system-prompt` row drops the fixed English harness opener and uses the 国盛证券办公助理 identity. The profile launcher applies `sanitizeGsPromptPatches` to every patch layer at startup and reload, including persona rows inside Agent presets. Complete presets keep their tool and runtime-context choices and include the language directive in their prefix. The independent `gs-prompt-language` plugin registers the Chinese system rule and appends an attributed bilingual reminder after downstream injections on each non-empty pre-step batch; rejected or empty batches remain unchanged.
- **gsclaw-server rows** — inserts `gs-server` (`@deepseek-ai/dsh-gs-server`), `llm-gs-gateway` (`@deepseek-ai/dsh-llm-gs-gateway`), `sensitive-policy` (`@deepseek-ai/dsh-sensitive-policy`), and `gs-server-skills` (`@deepseek-ai/dsh-gs-server-skills`) by name. The `gs-server` row supplies the two fields its Config requires: `stateDir` resolves at activation to `<profile dir>/gs-server` and `clientVersion` to the `DSH_CLIENT_VERSION` the Desktop shell passes to the Host (a plain CLI launch reports `0.0.0-cli`); the remaining config fields belong to the provider packages.
- **Vision channel** — inserts `gs-vision-bridge` (`@deepseek-ai/dsh-gs-app/vision-bridge`). A plain `mcp-client` config row cannot express this mount: the child script path derives from this bundle's own module URL, and the loopback proxy origin/token are per-boot runtime values. The bridge reads the optional `gsLlmGateway` service (provided by `dsh-llm-gs-gateway`) through `ctx.get`, then mounts `@deepseek-ai/dsh-mcp-client` over stdio onto the bundle-local `src/mcp-vision-server.ts`, registering `mcp__vision__analyze_image`. The per-boot proxy placeholder token reaches only that child through the mcp-client `env` carve-out — never `process.env` or disk — and the proxy swaps it for the real gsclaw access token at forward time. Without the gateway service the bridge logs a warning and leaves the tool unmounted rather than failing the boot.
- **Model-access posture** — disables `llm-deepseek` (a direct adapter would bypass the gsclaw gateway) and `ui-settings-models` (the Models page would hold provider keys on the client), mirroring the desktop product's proxy-only posture.
- **Brand posture** — disables `ui-brand-official` and installs `ui-brand-gs`, which fills the sidebar and conversation hero from the Host's gsclaw brand route.
- **Office UI and tasks** — installs the account menu, Skills settings page, skills routes, and the schedule service and page.
- **Local skill admission** — the launcher applies `sanitizeGsSkillEntries` after composing every bundle, profile, home, and invocation patch, on reload, and before each Agent preset mounts. Generic `skill-filesystem` rows are disabled by id or package, including renamed and nested rows. Skill rows admit only the canonical registry, tools, UI, bundled badge, and GS providers; a substituted canonical id is disabled. Native nested Includes are disabled because their independently loaded files do not carry the product policy. Local skills use the managed directory and `~/.skills` through the GS provider, which checks server permissions on discovery and body loading; server configuration pushes invalidate the catalog without a restart.

The Skills route includes the server runtime type, trusted-model restriction, and individual unavailability reason from the preference service. It distinguishes unsupported execution and incomplete migration from an account's disabled switch; existing activation restrictions still apply.

The vision tool supplies image understanding to the text model without a user-facing model selector. Every call uses `/vision/chat/completions` on the loopback gateway and `/api/v1/llm/vision/chat/completions` on gsclaw-server. The server resolves `models.visionModel` on each call, enforces provider authorization, and records metadata logs. Changing the server configuration requires no client model configuration or restart. Deploy the server endpoint before updating the client.

### gs-vision-bridge config

| Field | Default | Meaning |
|---|---|---|
| `serverName` | `vision` | MCP namespace; the tool appears as `mcp__<serverName>__analyze_image` |
| `toolCallTimeoutMs` | `120000` | Per-call timeout; stays above the vision server's own 110 s request timeout so its readable error wins |

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Deployment and preset agents use the 国盛证券办公助理 identity. An independent system section defaults all user-facing communication, progress, questions, errors, and tool display text to Simplified Chinese. Explicit user language choices and requested-language deliverables remain supported; code, commands, paths, URLs, and original logs retain their meaning and spelling. English skill text does not select the conversation language.

##### Persona, language section, and working-directory suffix

```markdown
你是国盛证券的办公助理，为国盛证券员工提供日常办公支持，包括文档撰写与整理、资料查询、数据汇总、会议纪要、流程指引等。回答应当专业、准确、简洁；涉及具体业务数据或内部规定时，以可核实的资料为准，不确定的内容要明确说明，不要臆造。

默认使用简体中文与用户交流；用户明确指定其他交流语言时，遵从用户要求。
这项规则适用于每一条面向用户的消息：开始执行前的说明、工具调用之间的进度汇报、澄清问题、错误解释、总结和最终回复。不要只在最终回复时才使用中文。
调用工具时，供用户阅读的自然语言字段也使用相同的交流语言，例如执行说明 description、审批理由 justification 和进度标题。代码、命令、参数键名、标识符、文件路径、URL、日志原文和技术术语保持原文，不要翻译或改变执行含义。
技能目录、SKILL.md、工具描述、工具结果或历史消息使用英文，不代表用户要求切换交流语言；继续遵守用户的语言要求。用户要求生成英文文档或翻译内容时，仅对指定交付内容使用目标语言，其余交流仍遵守上述规则。

Your working directory is {{cwd}}.
```

#### Token effect

The persona and language directive are fixed per-request costs. Each accepted non-empty input batch adds one short bilingual language reminder; duplicate reminders in that batch are skipped. Both system text and reminders enter the durable Session history.

#### KV Cache effect

The persona and language sections stay stable while the policy text is unchanged. Reminders append to history after the reusable prefix; changing policy text changes subsequent system-prompt assemblies.

### Vision tool

#### What the model sees

`mcp__vision__analyze_image` adds one tool schema to every request while registered. Calls read a local image (PNG/JPEG/WebP/GIF, ≤ 2.5 MB raw), send it as a chat-completions data URI through the loopback model-gateway proxy, and return the analysis as text — image bytes never enter model history or session events, and the child process holds only the per-boot proxy placeholder token.

#### Token effect

One fixed tool schema per request while registered; each call adds the analysis text as its result.

#### KV Cache effect

The schema stays prefix-stable while registered; results append after the reusable prefix without invalidating it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Runtime package resolution** — the integration rows mount by package name from `cordis.patch.yml`, and the launcher imports this bundle's prompt and skill policies by their public subpaths. The CLI installation must carry this bundle and its declared dependencies.
- **Vision proxy coordinates are service-read, not configured** — the bridge reads `origin`/`token` from the `gsLlmGateway` service (`@deepseek-ai/dsh-llm-gs-gateway`) via `ctx.get` at mount time; the row order in `cordis.patch.yml` (gateway before bridge) is what guarantees the service exists. If the gateway row is removed or reordered after the bridge, the vision tool stays unmounted with a warning.
- **Shell chrome copy** — the in-app sidebar and hero use the GS brand; Electron-owned update dialogs may still use upstream copy.
- **Default model arrives through the gateway mirror** — the base `agent-default-model` row's static `deepseek-official/deepseek-flash` default is rewritten at runtime by `dsh-llm-gs-gateway` from the server-pushed ClientConfig models catalog; this bundle sets no default itself.
- **Plugin admission is not code isolation** — third-party skill rows and nested Includes are unsupported in GS profiles. The policy checks declared plugin identities; arbitrary code mounted directly by another plugin is outside profile admission. Revoking local skill access prevents subsequent loading and invocation, but does not remove skill instructions already recorded in a conversation.

**Runtime invariant:** No companion is published because the bundle is a patch layer whose rows are proven by composition tests; it owns no runtime state relation independent observations could diverge from.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context; shipped behavior lives in the sections above and the package code.

Migrated from the desktop product's `dsh-plugin-desktop` patch layer (dsh-desktop, read-only): the persona and language rule moved from launcher code into the `system-prompt` row config, and the programmatic MCP mount became the `gs-vision-bridge` row.

</details>
