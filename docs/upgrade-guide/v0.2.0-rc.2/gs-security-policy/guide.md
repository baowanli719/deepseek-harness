---
kind: upgrade-guide
description: "GS profiles require encrypted gateway transport, durable private-session enforcement, and installers signed by the installed publisher."
---

# GS gateway and security policy

English | [中文](guide.zh.md)

## Change

GS profiles require HTTPS for non-loopback endpoints, including LAN gateways; only localhost and literal loopback addresses accept HTTP. Invalid explicit configuration fails startup. Endpoint changes end the current login, and logout invalidates pending authentication and configuration responses.

All private sessions deny configured egress tools and external MCP tools, including vision. Policy transitions are persisted as `sensitive/policy` before sensitive operations. Server read-only and plan settings constrain execution even when a local preset requests wider access. The tool-mediated sandbox profile currently resolves to read-only. External feedback telemetry is disabled. Skill files are fetched under current authorization and cached separately by endpoint and account.

GS installers require HTTPS downloads, the server download window, and native verification after download and before installation. Windows requires the installed signing certificate and a timestamp. macOS requires the installed Team ID and Gatekeeper acceptance. GS macOS packaging uses its own server update channel.

## Migration

1. Enable TLS with a certificate trusted by the operating system on the GS gateway. Set `GSCLAW_ENDPOINT`, `gs-server.config.endpoint`, and any persisted `gs-endpoint.json` override to an HTTPS URL. Re-login after changing endpoints; confirm authenticated metadata and model requests succeed.
2. Keep the `sensitive-policy` and `gs-agent-policy` rows from the GS bundle and a durable Session backend. Confirm private sessions remain private after restart and that read-only or plan settings refuse mutations. Review workflows that previously used shell, network, or vision tools in private sessions.
3. Build signed installers. Distribute a replacement Windows signing certificate through an approved full installation; automatic updates pin the installed certificate. Verify unsigned or differently signed packages are refused before installation. On macOS, keep the login Keychain accessible for refresh-token protection.
4. Reauthenticate to retrieve skills under the current account. Old shared bundle directories are not reused. See the [private-policy persistence record](../../../persistence-changes/2026-10-02-gs-private-policy.md) for compatibility details.
