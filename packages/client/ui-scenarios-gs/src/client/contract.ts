/** Renderer-safe mirror of the gs-server scenario-shortcuts wire fields. */

/** One server-configured scenario button. */
export interface GsScenarioShortcutItem {
  /** Non-blank stable identity within the delivered item list. */
  readonly id: string
  /** Non-blank server-owned display text. */
  readonly label: string
  /** Lowercase alphanumeric skill name with single-hyphen separators, inserted after the leading slash. */
  readonly skill: string
  /** False hides this item without changing its siblings. */
  readonly enabled?: boolean
}

/** Server-configured scenario shortcut list. */
export interface GsScenarioShortcutsConfig {
  /** False hides the complete list. */
  readonly enabled: boolean
  readonly items: readonly GsScenarioShortcutItem[]
}

/** Undefined selects client defaults; null hides the list. */
export type GsScenarioShortcutsSetting = GsScenarioShortcutsConfig | null | undefined

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Server scenario policy; undefined selects the client defaults. */
    'gs-scenarios': GsScenarioShortcutsSetting
  }
}
