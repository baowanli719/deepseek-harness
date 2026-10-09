/** Pending disclosure ownership; authorization completes only after a server receipt. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelSelection, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelRiskApi } from './api.ts'

/** One requested model awaiting consent, scoped to the choosing session. */
export interface ModelRiskRequest {
  readonly sessionId: SessionId
  readonly selection: ModelSelection
}

/** Root-owned authorization controller shared by the model list and consent dialog. */
export class ModelRiskController {
  /** Current pending choice or archived receipt being displayed. */
  readonly requests = createSnapshotStore<ModelRiskRequest | null>(null)
  private complete: ((accepted: boolean) => void) | undefined
  private generation = 0

  /** @param api - authenticated Host loopback policy and signing calls. */
  constructor(readonly api: ModelRiskApi) {}

  /**
   * Read current server policy and request a signature when required.
   * @param sessionId - choosing session.
   * @param selection - requested model.
   * @returns whether the model may be selected.
   */
  async authorize(sessionId: SessionId, selection: ModelSelection): Promise<boolean> {
    this.close()
    const generation = this.generation
    try {
      const status = await this.api.readStatus({ providerId: selection.provider, modelId: selection.model })
      if (generation !== this.generation) return false
      if (!status.required) return true
      if (status.consentId !== undefined) {
        this.requests.set({ sessionId, selection })
        return true
      }
    } catch (cause: unknown) {
      // The dialog exposes a retry; an unavailable policy never authorizes selection.
      void cause
    }
    if (generation !== this.generation) return false
    return new Promise<boolean>((resolve) => {
      this.complete = resolve
      this.requests.set({ sessionId, selection })
    })
  }

  /** Release the pending choice after the server returned a signed consent id. */
  signed(): void {
    const complete = this.complete
    this.complete = undefined
    complete?.(true)
  }

  /** Cancel an unsigned choice or dismiss an archived receipt. */
  close(): void {
    ++this.generation
    const complete = this.complete
    this.complete = undefined
    this.requests.set(null)
    complete?.(false)
  }
}
