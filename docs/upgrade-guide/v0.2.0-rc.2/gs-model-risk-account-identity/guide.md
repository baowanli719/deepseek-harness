---
kind: upgrade-guide
description: GS model-risk signatures use server account identity instead of client name and email fields.
---

# GS model-risk signer identity

English | [中文](guide.zh.md)

## Change

The model-risk sign request no longer requires or forwards `fullName` and `email`. The GS server resolves both from the authenticated account and employee directory. Model-list locks open consent before model selection; cancellation keeps the current model.

## Migration

1. Deploy the GS server update before the client. Confirm each account has a name and an active employee-directory email.
2. Update sign callers to send provider/model ids, revision, acknowledgement, and signature strokes. Remove client identity fields.
3. Update the GS client and confirm that choosing an unsigned row opens consent before switching. A signed receipt enables the choice and offers PDF download; its stored identity and recipients must match the server account.
