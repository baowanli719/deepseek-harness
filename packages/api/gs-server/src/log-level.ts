/**
 * Log verbosity primitives shared by the gsclaw-server log uploader.
 *
 * @module
 */

/** One Cordis logger severity, mirroring `@deepseek-ai/cordis`'s `LoggerType`. */
export type LogType = 'error' | 'info' | 'warn' | 'debug'

/** User-selectable log verbosity threshold. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const VERBOSITY: Record<LogType, number> = { error: 0, warn: 1, info: 2, debug: 3 }

/**
 * Whether a message of `type` should be emitted at `threshold`.
 * @param type - severity of the message.
 * @param threshold - configured verbosity ceiling.
 * @returns true when the message passes the threshold.
 */
export function shouldEmit(type: LogType, threshold: LogLevel): boolean {
  return VERBOSITY[type] <= VERBOSITY[threshold]
}
