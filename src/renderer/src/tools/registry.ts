import type { Tool, ToolOptions } from './types'

const tools = new Map<string, Tool>()

export function register(tool: Tool): Tool {
  if (tools.has(tool.id)) {
    throw new Error(`Duplicate tool id: ${tool.id}`)
  }
  tools.set(tool.id, tool)
  return tool
}

export function getAll(): Tool[] {
  return [...tools.values()]
}

export function getById(id: string): Tool | undefined {
  return tools.get(id)
}

/** Build the initial option values for a tool from its declared defaults. */
export function defaultOptions(tool: Tool): ToolOptions {
  const opts: ToolOptions = {}
  for (const o of tool.options ?? []) {
    if (o.default !== undefined) opts[o.key] = o.default
    else if (o.type === 'boolean') opts[o.key] = false
    else if (o.type === 'select') opts[o.key] = o.choices?.[0] ?? ''
    else opts[o.key] = ''
  }
  return opts
}
