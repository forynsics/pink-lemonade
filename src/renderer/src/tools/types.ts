export type ToolCategory = 'text' | 'ioc' | 'query'

export interface ToolOption {
  key: string
  label: string
  type: 'boolean' | 'string' | 'select'
  default?: string | boolean
  choices?: string[]
}

/** Runtime option values keyed by ToolOption.key. */
export type ToolOptions = Record<string, string | boolean>

export interface Tool {
  /** Stable, namespaced id, e.g. 'text.base64.decode'. */
  id: string
  name: string
  category: ToolCategory
  description: string
  options?: ToolOption[]
  /**
   * The operation. Pure and synchronous so it runs in the renderer (no Node/IPC) and is
   * trivially testable. runWorkflow chains these synchronously and does NOT await Promises,
   * so a Tool must return a string. Async/networked work (enrichment) is a separate
   * main-process surface (`enrich:*` / the Enrichment tab), not a Tool.
   */
  run: (input: string, opts?: ToolOptions) => string
}
