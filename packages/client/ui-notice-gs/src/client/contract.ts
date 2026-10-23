/**
 * Wire contract of the gs-server notice loopback route
 * (`/api/gs-server/notice`). Mirrors the `GsNoticeConfig` declaration exported
 * by `@deepseek-ai/dsh-gs-server`; the browser half declares the shape locally
 * because that package's compiler face is Host-only. Keep the two in step when
 * the contract evolves.
 */

/** Server-pushed notice banner; absent scheduling fields impose no limit. */
export interface GsNoticeView {
  /** Banner body, pre-wrapped. */
  readonly text: string
  /** ISO time the banner becomes visible; absent shows it immediately. */
  readonly startAt?: string
  /** ISO time the banner stops showing; absent keeps it until removed or dismissed. */
  readonly endAt?: string
  /** Whether the reader may close the banner; absent means closable. */
  readonly dismissible?: boolean
}
