export type VibeSnapshot = {
  state: string
  stage: string
  total: number
  pass: number
  fail: number
  stale: number
  failing: string[]
  inboxOpen: number
}

declare module 'claude-code' {
  interface PluginState {
    'vibe-status': { snapshot: VibeSnapshot | null; isHidden: boolean }
  }
}
