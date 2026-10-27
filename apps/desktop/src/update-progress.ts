/** Localized stages for the shell-owned update progress dialog. */
import type { DesktopUpdateState } from './ipc.ts'
import { formatDesktopMessage, type DesktopMessages } from './locale.ts'

/**
 * Select measured download progress or an indeterminate local operation.
 * @param state - Current updater operation.
 * @param messages - Shell-owned locale.
 * @returns Visible progress, or undefined when confirmation or recovery owns the dialog.
 */
export function desktopUpdateProgress(state: DesktopUpdateState, messages: DesktopMessages): {
  message: string
  progress: { percent?: number }
} | undefined {
  const labels: Record<DesktopUpdateState['phase'], string | undefined> = {
    idle: undefined, checking: undefined, available: undefined, ready: undefined, error: undefined,
    downloading: state.percent === undefined ? messages.updateDownloadingUnknown
      : formatDesktopMessage(messages.updateDownloading, { percent: String(Math.floor(state.percent)) }),
    verifying: messages.updateVerifying, preparing: messages.updatePreparing, installing: messages.updateInstalling,
  }
  const message = labels[state.phase]
  return message === undefined ? undefined : { message,
    progress: state.phase === 'downloading' && state.percent !== undefined ? { percent: state.percent } : {} }
}
