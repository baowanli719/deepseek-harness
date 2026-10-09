# gs-worker project records

English | [中文](README.zh.md)

## Summary

These records collect the GS desktop requirements, delivered changes, security review, and verification evidence by packaged version. They distinguish product versions from test-build versions and the bundled Harness runtime. Package READMEs remain the owners of current configuration and API behavior.

## Table of Contents

- [Version records](#version-records)
- [Version source](#version-source)

-----

<a id="version-records"></a>
## Version records

Each record names its packaging evidence and verification limits. A record does not certify an existing installer as containing later source changes.

| Packaged version | Product version | Record |
| --- | --- | --- |
| `2.2.0` | `2.2.0` | [Requirements, changes, and verification](releases/2.2.0/requirements-and-changes.md) |
| `2.1.1-test.20261002.3` | `2.1.1` | [Requirements, changes, and verification](releases/2.1.1-test.20261002.3/requirements-and-changes.md) |

<a id="version-source"></a>
## Version source

The [GS product manifest](../../apps/desktop/brand/gs/product.json) declares the product version. The [desktop release resolver](../../apps/desktop/scripts/desktop-release-environment.mjs) selects it for `gs-desktop`; the [build-version resolver](../../apps/desktop/scripts/desktop-build-version.mjs) derives the published test version. The [desktop package manifest](../../apps/desktop/package.json) identifies the bundled Harness runtime version. The local packaging run metadata and final stage result establish which build actually succeeded; credentials and installer binaries stay outside these records.
