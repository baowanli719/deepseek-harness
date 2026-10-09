/**
 * Wire contract of the gs-server model-risk loopback routes
 * (`/api/gs-server/model-risk/status|sign|download`). Mirrors the
 * `GsModelRisk*` declarations exported by `@deepseek-ai/dsh-gs-server`; the
 * browser half declares the shapes locally because that package's compiler
 * face is Host-only. Keep the two in step when the contract evolves.
 */

/** Status request for one provider/model route. */
export interface GsModelRiskStatusRequest {
  readonly providerId: string
  readonly modelId: string
}

/** Server view of the current disclosure and the account's signing state. */
export interface GsModelRiskView {
  /** Whether this route requires a signed disclosure before use. */
  readonly required: boolean
  /** Protocol revision the signature must name. */
  readonly revision: string
  readonly title: string
  /** Full disclosure text, pre-wrapped. */
  readonly text: string
  /** Archived consent id once the account has signed this revision. */
  readonly consentId?: string
  /** Delivery state of the archived-PDF mails. */
  readonly mailStatus?: 'sent' | 'failed' | 'pending'
}

/** One signing submission. */
export interface GsModelRiskSignRequest extends GsModelRiskStatusRequest {
  readonly revision: string
  /** Explicit confirmation checkbox state; the server rejects false. */
  readonly acknowledged: boolean
  /** Handwriting strokes as normalized [0,1] point sequences. */
  readonly signature: number[][][]
}

/** Archived-PDF request for one consent. */
export interface GsModelRiskDownloadRequest {
  readonly consentId: string
}

/** Archived-PDF response. */
export interface GsModelRiskDownloadResponse {
  readonly pdfBase64: string
}
