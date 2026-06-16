import {
  Binary,
  FileText,
  Shuffle,
  CaseSensitive,
  AlignLeft,
  Link2,
  Globe,
  Hash,
  Terminal,
  ShieldAlert,
  Mail,
  Layers,
  ShieldOff,
  ShieldCheck,
  Database,
  Search,
  type LucideIcon
} from 'lucide-react'
import type { ToolCategory } from '../tools/types'

// Map our real, namespaced tool ids -> lucide icons. Presentational only, so it lives
// here instead of polluting the tool registrations. Unknown ids fall back by category.
const BY_ID: Record<string, LucideIcon> = {
  'text.base64.encode': Binary,
  'text.base64.decode': FileText,
  'text.dedup': Shuffle,
  'text.case': CaseSensitive,
  'text.whitespace': AlignLeft,
  'text.url.encode': Link2,
  'text.url.decode': Globe,
  'text.hex.encode': Hash,
  'text.hex.decode': Terminal,
  'ioc.extract.ipv4': ShieldAlert,
  'ioc.extract.domain': Globe,
  'ioc.extract.url': Link2,
  'ioc.extract.email': Mail,
  'ioc.extract.md5': Layers,
  'ioc.extract.sha1': Layers,
  'ioc.extract.sha256': Layers,
  'ioc.defang': ShieldOff,
  'ioc.refang': ShieldCheck,
  'query.crowdstrike.cql': Database,
  'query.mde.kql': Search,
  'query.splunk.spl': Database
}

const BY_CATEGORY: Record<ToolCategory, LucideIcon> = {
  text: FileText,
  ioc: ShieldAlert,
  query: Database
}

export function toolIcon(toolId: string, category: ToolCategory): LucideIcon {
  return BY_ID[toolId] ?? BY_CATEGORY[category] ?? FileText
}
