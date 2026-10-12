---
kind: upgrade-guide
description: "GS profiles restrict gateway transport, except for the specified HTTP deployment, and require durable private-session enforcement and installers signed by the installed publisher."
---

# GS gateway and security policy

English | [中文](guide.zh.md)

## Change

GS profiles default to `http://192.168.230.108:8151/gsclaw`. Only this exact deployment endpoint, localhost, and literal loopback addresses accept HTTP; other endpoints, including other LAN gateways, require HTTPS. Invalid explicit configuration fails startup. Endpoint changes end the current login, and logout invalidates pending authentication and configuration responses.

GS private sessions retain shell, network and external MCP tools, including vision. Their local file preset controls execution; full access permits Python, subprocesses and files outside the workspace without sandbox ACL edits. Standard sessions retain server filesystem ceilings; authentication and plan-only denial apply to all sessions. Trusted model routes and audit headers remain enforced, and policy transitions persist as `sensitive/policy` before sensitive operations. External feedback telemetry is disabled. Skill files are fetched under current authorization and cached separately by endpoint and account.

GS installers require HTTPS downloads, the server download window, and native verification after download and before installation. Windows requires the installed signing certificate and a timestamp. macOS requires the installed Team ID and Gatekeeper acceptance. GS macOS packaging uses its own server update channel.

## Migration

1. For the specified trusted-network deployment, use `http://192.168.230.108:8151/gsclaw`; update any `GSCLAW_ENDPOINT`, `gs-server.config.endpoint`, or persisted `gs-endpoint.json` override still selecting HTTPS. Authentication traffic on this endpoint is unencrypted. Other gateways need TLS with a certificate trusted by the operating system. Re-login after changing endpoints; confirm authenticated metadata and model requests succeed.
2. Keep the GS bundle rows and a durable Session backend. Remove custom row overrides or set `sensitive-policy.config.egressTools: []`, `restrictExternalMcp: false`, and `gs-agent-policy.config.privateFullAccess: true`. Restart and select full access to allow local Python, subprocesses, network tools and workspace-external files in private sessions. Confirm privacy survives restart, untrusted model routes are refused, and locally selected read-only or server plan-only policy still refuses writes. To restore the former restrictions, omit the tool overrides and set `privateFullAccess: false`.
3. Build signed installers. Distribute a replacement Windows signing certificate through an approved full installation; automatic updates pin the installed certificate. Verify unsigned or differently signed packages are refused before installation. On macOS, keep the login Keychain accessible for refresh-token protection.
4. Reauthenticate to retrieve skills under the current account. Old shared bundle directories are not reused. See the [private-policy persistence record](../../../persistence-changes/2026-10-02-gs-private-policy.md) for compatibility details.
