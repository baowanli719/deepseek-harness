/** Plugin interception of ordinary HTTP(S) links selected in Chat. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Offer a link to plugins before applying the user's browser preference.
     * Return true only after taking ownership; otherwise leave the result undefined.
     * @param sessionId - Session containing the selected link.
     * @param url - Sanitized absolute HTTP(S) destination.
     * @mode bail
     */
    'chat/open-link'(sessionId: SessionId, url: string): true | void
  }
}
