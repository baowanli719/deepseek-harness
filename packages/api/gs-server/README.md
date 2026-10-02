---
description: "gsclaw-server integration: token state machine with encrypted-at-rest refresh token, authenticated HTTP client with 401 retry, ClientConfig cache, brand store, private loopback routes, and log upload."
kind: "package-reference"
---

# @deepseek-ai/dsh-gs-server

English | [中文](README.zh.md)

## Summary

The gs-worker office Agent's gsclaw-server client: the `gsServer` Cordis service owns endpoint resolution, the authentication token state machine (access tokens memory-only, rotating refresh tokens sealed at rest through an OS-backed protector), an authenticated HTTP client with a single-flight 401 refresh retry, the server-driven ClientConfig cache, the brand store, the private `/api/gs-server/*` loopback routes, and best-effort client log upload.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

`GsAuthUser` is the token-free account projection (`id`, `username`, `displayName`, `role`). `GsClientConfig` is the validated server policy snapshot for Agent limits, features, settings pages, permissions, skills, models, app updates, notices, and optional branding. Their wire fields are declared in `src/contract.ts`; session and configuration events carry these projections without access or refresh tokens.

Authentication commits are bound to a generation and serialized with credential writes. Logout invalidates in-flight login, restore, refresh, and configuration pulls before removing local credentials; `gs-server/session-ended` notifies consumers. Changing endpoints first ends the old session. Invalid explicit endpoint configuration fails startup; non-loopback services require HTTPS.

Compose the plugin on the Host with a `stateDir` and the client version it reports to the gateway:

```yaml
- name: '@deepseek-ai/dsh-gs-server'
  config:
    stateDir: /var/lib/my-host/gs-server
    clientVersion: 1.0.0
```

`Config` fields: `stateDir` (required; holds `gs-refresh-token.bin`, `gs-endpoint.json`, `gs-brand.json`), `endpoint` (deployment default `https://192.168.230.108:8151/gsclaw`; the persisted override and the `GSCLAW_ENDPOINT` environment seam win over it), `environment` (explicit environment override value), `clientVersion` (required), `clientPlatform` (defaults to the running OS), `protector` (refresh-token protector; see below), `routes` (default true; mounts the private routes on `ctx.webServer` and fails to start when no webServer is composed), `restoreOnStart` (default false; restore a sealed session before the Desktop startup gate reads it, while preserving the token on transport failure), `authRequestTimeoutMs` (default 15000; authentication and ClientConfig request deadline, including startup restore; model streams keep caller cancellation), `logUpload` and `logLevel` (client log upload opt-in), `request` (fetch override for host adapters and tests).

Consumers declare `inject = ['gsServer']` and use the service contract: `getAccessToken()` resolves the in-memory access token (undefined while signed out), `fetch(path, init)` runs an authenticated request against the resolved endpoint with the Bearer token and policy-version header attached, refreshing once on an expired-token 401, and `getClientConfig()` returns the latest cached server ClientConfig. Declaration-merged root events: `gs-server/session-established` (login, token adoption, restore, refresh), `gs-server/session-expired` (refresh rejected with 401), `gs-server/trust-revoked` (refresh rejected with 403), and `gs-server/client-config-changed` (payload: the new ClientConfig).

Hosts driving their own login UI use the service surface directly: `getMeta`/`getAuthMethods`/`fetchCaptcha` for the pre-login handshake, `loginWithPassword`/`sendEmailCode`/`loginWithEmailCode` for the built-in flows, `adoptTokens` as the token-write entry for externally issued pairs (SSO, QR), `restoreSession` after a restart, `logout`, `sessionView`, `brandView`, `refreshClientConfig`, and the `setEndpointOverride`/`clearEndpointOverride` pair. With `routes` enabled, the same surface is served over same-origin loopback HTTP at `/api/gs-server/meta`, `/session`, `/brand`, `/captcha`, `/login`, `/email-code`, `/email-login`, and `/logout`; credential state never leaves the Host process.

The refresh token is the only credential persisted across restarts. Windows uses CurrentUser DPAPI; macOS uses AES-GCM with its master key in the login Keychain. Other platforms refuse persistent login unless the host injects an OS-backed `Config.protector`. Subprocesses receive secrets over stdin, never command-line arguments.

<a id="understand-the-implementation"></a>
## Understand the implementation

`endpoint.ts` validates endpoints (plain HTTP only for literal loopback addresses and localhost) and resolves override → environment → configured default; the persisted override is loaded once so `resolve()` stays synchronous. `auth.ts` funnels every refresh through one single-flight promise because the server treats a concurrent refresh as token replay and revokes the family; a 401/403 refresh answer wipes local state and fires the matching session event. `client.ts` normalizes the legacy `{ error, message }` and the `/api/v1` `{ code, message, traceId }` envelopes into `GatewayError` and enforces a 1 MiB response cap. `config.ts` caches the pushed or pulled ClientConfig and notifies subscribers; every change also reaches the brand store and the `client-config-changed` event. `brand.ts` resolves server push → persisted cache → built-in default. `routes.ts` answers only same-origin loopback requests (socket, Host header, and fetch-metadata checked by `loopback.ts`). `log-exporter.ts` buffers masked Cordis log messages and posts bounded batches to `/api/logs/client`, dropping rather than retrying on any failure. The package owns no relation that an independent observer could check, so no invariant companion is published.

<a id="model-experience"></a>
## Model Experience

None, as gsclaw-server credentials and the ClientConfig cache affect HTTP authentication only and the package registers no prompt, tool, or Session event.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The desktop login and update UI are owned by `apps/desktop`; this package supplies token-free private routes. `GET /api/gs-server/app-update` actively pulls authenticated `/api/client-config` and returns only its `appUpdate` field; a failed pull returns an error, and gateway credentials stay in the Host.
- Linux secret storage is deferred; Linux requires an injected OS-backed `Config.protector` or login fails. macOS requires an unlocked, accessible login Keychain.
- The `/api/gs-server/skills` and `/api/gs-server/local-skills` routes are deferred to the skill-provider packages (the wire types and path constants stay in `contract.ts`); this package owns the session/brand/auth/update routes.
- Native desktop product copy is owned by `apps/desktop`; other consumers read `brandView()` or subscribe to the brand store.
- Route registration resolves `ctx.get('webServer')` at service init, so a host enabling `routes` must compose `@deepseek-ai/dsh-host-webserver` before this plugin; `inject` is not declared because the routes are an optional surface.
- The log uploader's diagnostic sink (`localLog`) is left unwired by the plugin, so queue-overflow and dropped-batch notes are discarded; hosts that want them construct `GsLogExporter` themselves.

<a id="dev-note"></a>
### Dev Note

Migrated from the gs-worker desktop product (`dsh-plugin-desktop/src/server/gs-*.ts`); the Electron `safeStorage` dependency became the `GsRefreshTokenProtector` seam in `protector.ts`.
