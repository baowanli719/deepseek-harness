/** Native server-update notifications are shown once per version in an application lifetime. */
export class GsUpdateNotifications {
  private readonly prompted = new Set<string>()
  private pending: Promise<void> = Promise.resolve()
  private latest: string | undefined

  /**
   * @param prompt - Native confirmation flow; notification alone never authorizes download.
   */
  constructor(private readonly prompt: () => Promise<void>) {}

  /**
   * Notify for a newly available release, joining repeated checks without prompting again.
   * @param version - Strictly newer, platform-applicable version from the update coordinator.
   * @returns Completion of the native flow or an immediate no-op for a repeated version.
   */
  async available(version: string): Promise<void> {
    this.latest = version
    if (this.prompted.has(version)) return
    this.prompted.add(version)
    const operation = this.pending.then(async () => {
      if (this.latest !== version) { this.prompted.delete(version); return }
      await this.prompt()
    })
    this.pending = operation.catch(() => {})
    await operation
  }
}
