---
kind: upgrade-guide
description: "Desktop updates expose installation preparation and automatically install verified GS macOS updates."
---

# Desktop update preparation and restart

English | [中文](guide.zh.md)

## Change

The Desktop update presentation includes a `preparing` phase between artifact verification and readiness. GS macOS updates stage the signed application and use the native updater for replacement and automatic relaunch after installation consent. The progress dialog remains open during download, verification and preparation. Download percentages are absent until the content length is known; local preparation has no fabricated percentage.

## Migration

1. Custom Desktop update consumers must handle `preparing` as a busy state and allow `percent` to be absent during download.
2. Install GS updates through the client’s download and restart confirmations. macOS no longer requires copying the app from an opened DMG. The installed app and update must have the same Team ID and pass Gatekeeper; unsigned development builds cannot use this native update path.
3. If preparation fails, retry from the running client. A normal exit does not install an update. Existing conversation data stays in its product home.
