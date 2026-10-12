# gs-worker requirements and changes: 2.2.0

English | [中文](requirements-and-changes.zh.md)

## Summary

This version-scoped reference records the GS desktop 2.2.0 feature: untrusted cloud models require a signed electronic risk disclosure before use. The client shows a lock in each untrusted model-list row, requires reading and signing the server-issued disclosure before selection, and downloads the archived PDF; the server stores the signed record and mails the PDF to the user and the configured administrators. This is a delivery record, not a business approval or production security certification. The client revision installer is delivered with matching server code.

## Table of Contents

- [Version and scope](#version-and-scope)
- [Requirements and delivery](#requirements-and-delivery)
- [Changes by area](#changes-by-area)
- [Server deployment coordination](#server-deployment-coordination)
- [Verification record](#verification-record)
- [Delivery conditions](#delivery-conditions)

-----

<a id="version-and-scope"></a>
## Version and scope

The product version moves from 2.1.1 to 2.2.0; the bundled Harness runtime version is unchanged.

| Item | Recorded value | Evidence |
| --- | --- | --- |
| Product | `gs-worker` / 国盛办公AI, profile `gs-desktop` | [GS composition](../../../../packages/bundle/gs-app/README.md) |
| GS product version | `2.2.0` | [Product manifest](../../../../apps/desktop/brand/gs/product.json) |
| Packaged version | `2.2.0` unsigned | The Windows revision installer includes the model-list authorization flow |
| Runtime version | `0.2.0-rc.2` | [Desktop package manifest](../../../../apps/desktop/package.json) |

<a id="requirements-and-delivery"></a>
## Requirements and delivery

| ID | Requirement and delivered behavior | Observable check / owner |
| --- | --- | --- |
| R01 | Show a lock at the right of each untrusted model row; trusted rows have no lock and failed status reads retain an unavailable lock. | Model-row states; [model-risk UI](../../../../packages/client/ui-model-risk-gs/README.md). |
| R02 | Choosing an unsigned model opens the full disclosure before switching; acknowledgement and handwriting authorize the choice, while cancellation keeps the previous model. The server account and employee directory supply name and email without client fields. | Selection authorization, signature request, and server identity lookup; same owner. |
| R03 | Sign against the exact protocol revision; reload the current text and ask for a fresh signature when the server reports a revision change. | Revision-conflict retry; same owner. |
| R04 | After signing, show the mail delivery state and offer the archived PDF download. | Mail status copy and `a[download]` flow; same owner. |
| R05 | Keep the gsclaw access token out of the renderer; disclosure traffic crosses the Host's same-origin `/api/gs-server/model-risk/*` loopback routes. | Route wiring in the GS server package; [GS server](../../../../packages/api/gs-server/README.md). |
| R06 | Ship the feature as product version 2.2.0. | Product manifest and packaging assertions. |

<a id="changes-by-area"></a>
## Changes by area

| Area | Modification | Owner |
| --- | --- | --- |
| Client | New `ui-model-risk-gs` plugin decorates `model.option.accessory`, guards model selection before the Host request, and hosts the disclosure dialog in `conversation.input.activity`; it captures normalized handwriting, reloads changed revisions, and downloads archived PDFs. | [model-risk UI](../../../../packages/client/ui-model-risk-gs/README.md) |
| Host | Loopback routes `/api/gs-server/model-risk/status`, `/sign`, and `/download` proxy the server with the in-memory access token. | [GS server](../../../../packages/api/gs-server/README.md) |
| Composition | The GS bundle mounts `ui-model-risk-gs` and declares the workspace dependency. | [GS composition](../../../../packages/bundle/gs-app/cordis.patch.yml) |
| Versioning | GS product version 2.1.1 → 2.2.0; packaging assertions follow the manifest. | [Product manifest](../../../../apps/desktop/brand/gs/product.json) |

<a id="server-deployment-coordination"></a>
## Server deployment coordination

The matching gsclaw-server release owns the consent archive, PDF rendering, and mail delivery. Deployment order and limits:

1. Update gsclaw-server, install dependencies, and run the database initialization to create the `model_risk_consents` archive table; back the table up under the existing policy. Existing data is preserved.
2. Install a Chinese font and point `MODEL_RISK_PDF_FONT` at its absolute path (TTF/OTF; TTC additionally accepts `MODEL_RISK_PDF_FONT_FAMILY`). Without a usable font the server refuses signing and release.
3. Configure the disclosure title, full text, and at least one administrator recipient on the server administration page; SMTP comes from the existing mail configuration. A failed or timed-out send keeps the signed record and marks delivery `failed` for later resend.
4. Publish the 2.2.0 client together with the server. Older clients cannot sign, and the server intercepts unsigned untrusted-model requests.

The server computes the protocol revision from the title, text, provider, model id, service address, and protocol type; changing any of them requires a fresh signature. Editing recipients alone does not invalidate existing signatures. Private sessions remain restricted to trusted model routes — signing never relaxes the sensitive-data gate. The signature is an electronic handwritten confirmation without a certificate, and the archived receiving email comes from the authenticated account employee-directory record.

<a id="verification-record"></a>
## Verification record

Source validation ran on native Windows.

| Evidence | Observed result |
| --- | --- |
| New package unit tests | 129 focused client, model-selection, and loopback tests pass, including row-lock expectations, signature-before-selection, cancellation, Loader registration, archived-PDF download, and request identity omission. The server identity route has 7 passing tests. |
| Typecheck | Repository typecheck passes with the new package referenced from the client aggregate. |
| Desktop version assertions | Packaging and version-resolution specs pass against product version 2.2.0. |

No live gsclaw-server signing, PDF, or mail request was made; the loopback routes were exercised against stubbed responses. End-to-end verification against a real server, database, font, and SMTP deployment remains release qualification work.

<a id="delivery-conditions"></a>
## Delivery conditions

1. Use the 2.2.0 revision installer from this source; no installer predating this record contains the feature.
2. Deploy the matching gsclaw-server first and complete its font, recipient, and SMTP configuration; older clients cannot sign.
3. Verify a real account's signing, PDF download, both recipient classes' mail delivery, and failed-mail resend before broad rollout.
