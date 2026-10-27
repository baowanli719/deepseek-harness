---
kind: upgrade-guide
description: "GS Desktop moves its default user data from ~/.dsh to ~/.gs-worker and automatically imports legacy GS data."
---

# GS Desktop uses a separate data directory

English | [中文](guide.zh.md)

## Change

GS Desktop (`gs-worker`, profile `gs-desktop`) defaults to `~/.gs-worker` instead of sharing `~/.dsh` with upstream Harness. Before its Host starts, it automatically copies legacy conversations, attachments, workspace state, GS profile and sign-in state, and managed credentials when `~/.dsh/profiles/gs-desktop` exists. Session files retain their bytes and identifiers. The source remains unchanged; existing destination files take precedence. Legacy history has no product identifier, so all previously visible conversations are included, even those shared with upstream Harness. A completed import is not repeated. CLI home defaults are unchanged.

## Migration

1. Leave `DSH_HOME` unset and upgrade GS Desktop normally. The first launch imports legacy data automatically; no manual copy is required. Existing valid sign-in state is retained, subject to the server's normal token-expiration rules.
2. Confirm that old conversations are visible and new data appears under `~/.gs-worker`. Upstream Harness continues to use `~/.dsh`; changes made there after import are independent.
3. If import cannot finish, let other clients finish saving and restart. Failed or interrupted imports can be retried without replacing existing destination files or deleting originals. Linked data directories require ordinary directories before import; plugin links are preserved.
4. An explicit nonblank `DSH_HOME` disables automatic import. CLI operations on the new home require an explicit `DSH_HOME` pointing to `~/.gs-worker`; intentionally selecting the old home retains the previous shared data.
