# gs-worker requirements and changes: 2.1.1-test.20261002.3

English | [中文](requirements-and-changes.zh.md)

## Summary

This version-scoped reference records the GS desktop requirements, integration changes, and security corrections reviewed on 2026-10-03. It combines the requested project review and publication work with the GS behavior delivered in the source. It is a delivery record, not a business approval or production security certification. The earlier local test installer predates the security corrections recorded here.

## Table of Contents

- [Version and scope](#version-and-scope)
- [Requirements and delivery](#requirements-and-delivery)
- [Changes by area](#changes-by-area)
- [Security corrections](#security-corrections)
- [Verification record](#verification-record)
- [Delivery conditions](#delivery-conditions)

-----

<a id="version-and-scope"></a>
## Version and scope

The successful local Windows packaging run supplies the complete version used for this record and branch. The product and runtime versions have different owners.

| Item | Recorded value | Evidence |
| --- | --- | --- |
| Product | `gs-worker` / 国盛办公AI, profile `gs-desktop` | [GS composition](../../../../packages/bundle/gs-app/README.md) |
| GS product version | `2.1.1` | [Product manifest](../../../../apps/desktop/brand/gs/product.json) |
| Packaged test version | `2.1.1-test.20261002.3` | Local packaging run completed successfully on 2026-10-02 at 21:59:58, Asia/Shanghai |
| Runtime version | `0.2.0-rc.2` | [Desktop package manifest](../../../../apps/desktop/package.json) |
| Version branch | `v2.1.1-test.20261002.3` | Named after the complete packaged version |
| Earlier review branch | `fix/gs-security-hardening-20261002` | GS integration and reviewed security corrections |
| Earlier installer | `gs-worker-2.1.1-test.20261002.3-win-x64-unsigned.exe` | Local unsigned Windows x64 artifact; packaged-runtime smoke stage succeeded |

The local run metadata names `win-x64`, `unsigned: true`, and a dirty working tree. The installer was created before the subsequent security fixes. This branch includes those reviewed fixes and this documentation; creating the branch does not rebuild or sign that installer. This task does not change version manifests, upload an installer, or create a release tag.

<a id="requirements-and-delivery"></a>
## Requirements and delivery

The rows summarize the implemented GS project scope and the user's instructions to review, fix, validate, publish, and document it. The observable checks provide acceptance criteria for deployment verification; they do not invent additional business requirements.

| ID | Requirement and delivered behavior | Observable check / owner |
| --- | --- | --- |
| R01 | Use GS product branding and the 国盛证券办公助理 identity; default user-facing communication to Simplified Chinese while honoring an explicit language choice. | Product icon, login screen, sidebar and conversation identity; [GS bundle](../../../../packages/bundle/gs-app/README.md). |
| R02 | Authenticate through gsclaw-server using the advertised login methods; restore an encrypted refresh credential; return to login after logout or account termination. | Login, restart, logout, and expired-session flows; [GS server](../../../../packages/api/gs-server/README.md). |
| R03 | Keep real access tokens and model-provider credentials on the Host/server side; route model and vision requests through the GS gateway. | Renderer receives account views; authenticated model requests use current server configuration; [model gateway](../../../../packages/llm/llm-gs-gateway/README.md). |
| R04 | List server/local skills, show availability reasons, control server skill activation, and admit local skill creation only when the server permits it. | Skills settings and rejected unauthorized loads; [skill provider](../../../../packages/skill/gs-server-skills/README.md). |
| R05 | Provide account/settings navigation, GS branding, and the scheduled-task service and page. | Account launcher, Skills page, sidebar/hero, and schedule entry; [GS composition](../../../../packages/bundle/gs-app/cordis.patch.yml). |
| R06 | Preserve Chinese prompt policy through profile patches, presets, reloads, and accepted input batches; keep input-trigger behavior consistent with editor state. | Attributed language reminders and input/reference-submit regression tests; [prompt policy](../../../../packages/bundle/gs-app/src/prompt-policy.ts). |
| R07 | Package a separately versioned GS desktop product with branded installer assets, installation scope/legacy-install handling, and its own update channel. | Version resolver, installer/package tests and packaging metadata; [desktop packaging](../../../../apps/desktop/README.md). |
| R08 | Enforce private-session egress rules, server Agent limits, credential safety, and authenticated update installation; fix identified issues and publish validated source. | Security and regression evidence below; [security migration guide](../../../upgrade-guide/v0.2.0-rc.2/gs-security-policy/guide.md). |

<a id="changes-by-area"></a>
## Changes by area

The integration spans the desktop shell, Host services, GS composition, and client interfaces. The linked owners describe configuration and exact behavior without duplicating their API catalogs here.

| Area | Modification | Owner |
| --- | --- | --- |
| Desktop and installer | Added GS login IPC/window, brand assets, configurable product/artifact identity, GS profile/version selection, installer scope and legacy-uninstall behavior, and GS update verification. | [Desktop](../../../../apps/desktop/README.md) |
| Account and gateway | Added authentication generations, encrypted credential persistence, server configuration/brand routes, credential-masked log export, model catalog mirroring, and vision routing. | [GS server](../../../../packages/api/gs-server/README.md), [gateway](../../../../packages/llm/llm-gs-gateway/README.md) |
| Session and execution | Added durable private policy, restoration projection, tool egress restrictions, and server limits applied to sandbox/approval resolution. | [Private policy](../../../../packages/guard/sensitive-policy/README.md), [Agent limits](../../../../packages/bundle/gs-app/src/agent-policy.ts) |
| Skills and client | Added server execution bridges, account-scoped preferences/cache, controlled local skills, account/brand/Skills interfaces, and conversation/input wiring. | [Skills](../../../../packages/skill/gs-server-skills/README.md), [account UI](../../../../packages/client/ui-account-gs/README.md), [Skills UI](../../../../packages/client/ui-skills-gs/README.md) |
| Build and repository checks | Updated dependencies, source mappings, profile fixtures, generated catalogs, persistence acknowledgement, and Windows-compatible filesystem/NodeNext test fixtures. | [Persistence record](../../../persistence-changes/2026-10-02-gs-private-policy.md), [testing policy](../../../testing.md) |

<a id="security-corrections"></a>
## Security corrections

The initial review identified eight P1 and two P2 security issues. The reviewed source addresses them through the following enforcement changes. These priorities describe the original findings, not vulnerabilities left open by this record.

| ID / original priority | Finding | Reviewed correction |
| --- | --- | --- |
| S01 / P1 | Installer authenticity was not verified. | HTTPS download without redirects; verify native signature and installed publisher identity after download and before installation. |
| S02 / P1 | Non-loopback plaintext transport and hostname-based private-network checks exposed credentials. | HTTPS required outside exact localhost/literal loopback; invalid explicit configuration fails startup; authenticated requests reject redirects. |
| S03 / P1 | GS inherited external session-feedback telemetry. | Disable the external session telemetry and feedback UI/command in the GS composition. |
| S04 / P1 | Some private sessions retained egress tools or could not strengthen their privacy policy. | Apply one monotonic private policy to every entry cause; deny configured egress tools and all external MCP tools at execution. |
| S05 / P1 | Private classification disappeared after restart. | Persist `sensitive/policy`, restore through a Session projection, and flush transitions before protected operations; provisional state cannot downgrade restored privacy. |
| S06 / P1 | Vision requests lacked sensitive-session attribution. | Mark forwarded vision requests sensitive even without a session identifier; private sessions also deny the external vision MCP tool. |
| S07 / P1 | Server Agent security settings did not constrain execution. | Clamp sandbox and approval resolution, deny tools without authenticated policy or in plan mode, and enter durable privacy for sensitive/confidential data classes. |
| S08 / P1 | Late login/refresh responses could restore a logged-out account. | Invalidate authentication generations immediately and serialize credential writes; account termination clears configuration and informs the desktop. |
| S09 / P2 | Warm trusted-only skill definitions bypassed revocation checks. | Recheck current account, feature/per-skill switches, preferences, generation, and privacy on every load. |
| S10 / P2 | Disk skill caches could reuse another account's content. | Partition by normalized endpoint/account and fetch current authenticated files before cache reuse; invalidate stale references. |

Additional corrections supply a per-boot CLI loopback credential, reconnect logout to the login window, enforce download windows including midnight crossings, add macOS login Keychain/AES-GCM credential protection, and separate GS macOS artifacts from the upstream update feed. Unresolved Windows links now fail closed before filesystem authorization falls back to a lexical path.

<a id="verification-record"></a>
## Verification record

The source validation ran on native Windows with Node `24.14.0` and pnpm `11.7.0`. The counts below describe the completed review runs; overlapping focused runs must not be summed as distinct tests. This documentation addition does not constitute another installer build or production release.

| Evidence | Observed result |
| --- | --- |
| Broad relevant regression run | 261 files / 8,774 tests: 8,713 passed, 56 skipped, 5 Windows fixture failures; the affected fixtures were corrected and owning tests rerun. |
| Filesystem owning rerun | 93 passed / 9 explicitly skipped for Windows-only missing symlink privileges or incompatible POSIX semantics. |
| GS focused regression | 27 files / 247 tests passed. |
| Desktop final regression | 7 files / 160 tests passed. |
| Adjacent source/document owners | 5 files / 197 tests passed. |
| CLI / vision focused regression | 25 CLI tests and 14 vision tests passed. |
| Build, lint and declarations | Complete build and lint passed; 333 workspace declaration APIs compiled under NodeNext. |
| Repository and documentation checks | 18 hygiene checks, 43 doc-sync checks, and module-graph freshness passed. |
| Built runtime and OS protection | Plain Node exercised compiled GS policy with actual filesystem denial/allowance, private events on disk and reopened persistence; native Windows DPAPI roundtrip passed. |
| Credential scan and Git hooks | Five URL-credential-shaped matches were confirmed synthetic test fixtures; normal commit and push hooks passed. |

The broad run is retained as qualified evidence rather than described as entirely passing. Focused tests cover the corrected failures. No production gsclaw-server login or business-data request was made. macOS Keychain, Gatekeeper and full packaging have unit/mocked coverage where applicable, but were not verified on a macOS machine. Remote CI results are not asserted by this record.

<a id="delivery-conditions"></a>
## Delivery conditions

Deployment verification must use a new installer built from the reviewed source. The old unsigned test artifact establishes version history only.

1. Configure an HTTPS gateway certificate trusted by the operating system and reauthenticate after endpoint changes. Follow the [security migration guide](../../../upgrade-guide/v0.2.0-rc.2/gs-security-policy/guide.md).
2. Keep durable Session storage and the GS policy plugins; verify private classification survives restart and read-only/plan policy rejects mutations. Consult the [private-policy owner](../../../../packages/guard/sensitive-policy/README.md).
3. Build and verify signed release installers. Windows automatic updates require the installed certificate plus a timestamp; macOS requires the installed Team ID and Gatekeeper approval. A certificate change requires an approved full installation.
4. Complete macOS native and production-server verification before making platform or deployment acceptance claims. Linux requires an explicitly supplied OS-backed refresh-token protector; no plaintext fallback is provided. Host plugins remain within the deployment's trusted-code boundary, as stated in the [GS bundle limitations](../../../../packages/bundle/gs-app/README.md#known-limitations-and-deferred-work).
