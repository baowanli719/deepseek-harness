---
description: "The gsclaw model-gateway adapter: a loopback proxy that swaps a per-boot placeholder token for the real gsclaw access token, plus hot mirroring of server ClientConfig models into the llm-pi-ai volatile config."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-gs-gateway

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-llm-gs-gateway` connects a gsclaw composition to the gsclaw-server model gateway. A 127.0.0.1 random-port proxy authenticates adapters with a per-boot placeholder token and forwards through `gsServer.fetch`, which attaches the real in-memory access token and owns the 401 refresh-retry; a request whose session id names a private session forwards with the `x-gsclaw-sensitive: 1` audit header. A mirror plans the server ClientConfig `models` section into `llm-pi-ai` provider profiles and the `agent-default-model` selection, written through the settings service so changes reach the running adapter without a restart.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Vision traffic always carries the sensitive audit header, even when the MCP subprocess has no Session identity. Private-session external MCP execution is denied by sensitive-policy. CLI GS startup creates a loopback credential when the Desktop host has not already supplied one.

The internal `/vision/chat/completions` loopback route forwards to `/api/v1/llm/vision/chat/completions` with the same boot-token authentication and bounded body handling as model calls. The server resolves `models.visionModel` on each request; no provider or vision model identifier is configured in the client.

Mount this plugin in a gsclaw composition alongside `gs-server` (provides `ctx.gsServer`), `settings`, a dormant `llm-pi-ai` mount (no configured providers), and `agent-default-model`. Both injected services are required: the plugin fails to load without them.

### Configure the adapter

Every deployment-owned name and bound is a Config field:

- `providerNamespace` — settings namespace (profile entry id) of the dormant `llm-pi-ai` mount the mirror owns outright (default `llm-pi-ai`).
- `defaultModelNamespace` — settings namespace of the `agent-default-model` mount receiving the server default model (default `agent-default-model`).
- `credentialRef` — credential reference the per-boot proxy token resolves through in mirrored profiles (default `DSH_GS_LLM_PROXY_TOKEN`).
- `maxBodyBytes` — maximum chat-completions request body the proxy accepts (default 4 MiB).
- `visionRouterNamespace` — optional Vision Router row configured through ConfigEditor (default empty; GS uses `vision-router`). Its backend uses the live `/vision` loopback endpoint and credential reference; the server resolves the dedicated model on each request.
- `visionMaxTokens` / `visionMaxImageBodyBytes` — visual-answer token limit and aggregate raw inline-image byte budget (defaults `4096` / `2800000`). The byte budget leaves room for base64 and the request envelope under the proxy cap.

### Wire the per-boot token

Mirrored profiles carry only the credential *reference*; the token itself never touches disk or `process.env`. The composition installs it as a `process`-layer entry of the launch-environment snapshot under `credentialRef`, either before mounting this plugin (the plugin adopts that token) or afterwards by wrapping the snapshot with `gsLlmGatewayLaunchEnvironment(base, ctx.gsLlmGateway.token)`. Without this wiring the proxy runs but the adapter cannot resolve the credential and requests fail closed with a missing-credential error.

### Read the published service

The plugin publishes `ctx.gsLlmGateway` with the proxy `origin`, the per-boot `token`, and `providerBaseUrl(providerId)` for compositions that build their own routes through the proxy.

<a id="understand-the-implementation"></a>
## Understand the implementation

### The loopback proxy

The listener binds 127.0.0.1 only, requires `Authorization: Bearer <boot token>` on every request, accepts POST `/v1/{providerId}/chat/completions` inside the provider route grammar, and caps the request body. Forwarding runs through `gsServer.fetch('/api/v1/llm/{providerId}/v1/chat/completions')` with a fresh header set — inbound client headers, including the placeholder token, never leak upstream — and every answer, SSE included, streams into the client response without buffering. The one inbound header the proxy reads is the session-affinity `x-session-id` the mirrored profiles switch on: when the optional `sensitivePolicy` service (`@deepseek-ai/dsh-sensitive-policy`) judges that session private, the upstream request carries `x-gsclaw-sensitive: 1`, rebuilt from the judgement so a forged inbound header can neither fake nor shed it. Expired-token handling lives inside `gsServer.fetch` (single-flight refresh, exactly one retry); a post-retry 401 passes through untouched. With no signed-in session the proxy answers 401 itself without touching the upstream. Disposing the plugin closes the listener and drains idle connections.

### The model mirror

`planGsLlmGatewayModels` turns the ClientConfig `models` section into sorted `openai-completions` provider profiles whose `baseURL` routes through the proxy and whose `apiKeyEnv` names the credential reference, plus the default selection from `defaultPrimary` (falling back to the first supplied model). Every mirrored profile sets `compat.sendSessionAffinityHeaders` with the `openrouter` format, so the adapter binds each session-bound request to its session id as a single `x-session-id` header on the loopback hop — the fact the proxy's audit judgement reads. Unusable providers and models are skipped with warnings instead of failing the mirror; a `null` or unusable section keeps local settings untouched. The mirror writes `providers` through `settings.replace` and the default selection through `settings.mutate` after Loader activation (from the cached ClientConfig), on `gs-server/session-established`, and on `gs-server/client-config-changed`; identical pushes are fingerprinted and skipped. The mirrored namespaces are owned outright: user edits survive only until the next push.

### Why llm-pi-ai and not llm-deepseek volatile config

The gsclaw-server gateway speaks OpenAI chat completions (`/v1/chat/completions`); the `llm-deepseek` adapter speaks the Anthropic-style Messages protocol against its `baseURL`, so pointing its volatile `baseURL`/`models` at the gateway would not produce a working route. The `llm-pi-ai` adapter already implements the multi-route pattern this migration needs — per-route `api`/`baseURL`/`apiKeyEnv`/`models` in one volatile `providers` dict, hot-applied on volatile commit — and the desktop product this replaces mirrored the same server plan into the same adapter. Mirroring into `llm-pi-ai` keeps the wire protocol correct, reuses the maintained adapter instead of duplicating it, and preserves prior behavior.

## Model Experience

Indirectly, through the mirrored `llm-pi-ai` provider profiles and default-model selection whose requests dsh-llm-pi-ai owns end to end.

#### KV Cache effect

The package adds no model-visible content; cache identity of forwarded requests belongs to the adapter and the server model plan, and a mirrored model switch simply starts a new conversation prefix under the adapter's own rules.

## Known Limitations and Deferred Work

- **The proxy owns no policy gate** — the desktop proxy's `judgePolicy` (fail-closed unknown sessions, trusted-provider judgment, header-less vision-lane exception) is replaced by `sensitive-policy`'s in-process enforcement at `llm/stream`, which direct callers cannot bypass; this package's part is the audit header, emitted only when the optional `sensitivePolicy` service is mounted, and the session-id hop that feeds it.
- **A session expiry keeps the last mirrored plan** — no event clears the mirrored providers or default model, matching the durable-settings behavior this replaces; requests fail with 401 at the proxy until a new session pushes a new plan.
- **The mirror requires the settings write path** — compositions without `settings` (or with renamed target namespaces that are not configured here) cannot receive the plan; Loader compositions mirror cached ClientConfig after activation and log write failures; without a Loader, an initial write failure rejects the mount. A settings write reconciles every Loader fiber, so awaiting it during this plugin's activation would block startup.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above and the package code.

- The desktop original buffered a 401 answer to drive its own refresh-retry; here the refresh contract moved into `gsServer.fetch`, so the proxy streams every status and owns no retry state.
- The mirror writes through `ctx.settings` rather than editing a settings document directly because the Loader volatile commit is the harness's one live-config path; a no-op fingerprint keeps identical pushes from churning settings revisions.

</details>

**Runtime invariant:** No companion is published. The proxy port, token, and mirrored settings are owned relationships created and torn down inside this plugin's own fiber, so no independent observation can diverge.
