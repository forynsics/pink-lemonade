export type ToolCategory = 'text' | 'ioc' | 'query' | 'enrich'

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
   * The operation. Pure and synchronous so it runs offline in the renderer and
   * is trivially testable. (v2 enrichment tools may return a Promise; runWorkflow
   * is structured to absorb that without API changes.)
   */
  run: (input: string, opts?: ToolOptions) => string
}
