// Which OTHER artifacts could plausibly corroborate a recorded event — the "worth a look" list on
// record_event.
//
// The first version matched one flat regex of artifact families against every un-cited source name,
// regardless of what the event was. So a pass-the-hash NETWORK LOGON was told to check Amcache and
// AppCompatCache, which record local program execution and cannot evidence a logon at all, and
// `Amcache_DriveBinaries` (a driver inventory) came up again and again. The agent's verdict: "after
// the third identical suggestion I stopped reading the field" — the worst outcome for a nudge whose
// whole job is to catch an omission.
//
// So: pick families by what the event IS. The ATT&CK tactics on the resolved technique already
// classify that, so we key off them rather than inventing a parallel taxonomy of our own.

import type { WsSource } from './types'

/** Artifact families, by what they can actually evidence. Matched against a source's filename. */
const FAMILY: Record<string, RegExp> = {
  // Local program execution.
  execution: /amcache|prefetch|\bpecmd\b|appcompat|shimcache|\bbam\b|userassist|srum|syscache|netassembly/i,
  // Files created, moved, deleted; and the shell traces of a user touching them.
  fileActivity: /\bmft\b|usn|journal|\$j\b|\blnk\b|lecmd|shellbag|sbecmd|recycle|rbcmd|jumplist|automaticdest|customdest/i,
  // Things that survive a reboot.
  persistence: /registry|recmd|runkey|startup|schedul|\btask\b|service|autorun|\bwmi\b/i,
  // Authentication and remote execution.
  remoteAccess: /\brdp\b|rdpcore|winrm|wsmprov|terminalserv|\blogon\b|\bauth\b|bitmapcache/i,
  // Browsing, downloads.
  browser: /hindsight|browsinghistory|webcache|browser|history|edge|chrome|firefox/i,
  // AV/EDR telemetry.
  defense: /defender|mplog|antivirus|quarantine|amsi/i
}

// Event logs corroborate nearly ANY kind of action — a logon, an execution, a service install, a log
// clear. They are always plausible, so they ride along with whatever the tactic selects rather than
// being tied to one family.
const UNIVERSAL = /hayabusa|evtx|sysmon|security|\bevent\b/i

// Not evidence at all: the parsers' own run logs, which record that a KAPE module executed — never
// what happened on the host. Suggesting these is exactly the noise that trained the agent to skip
// this field, and it dismissed them by hand in its report.
const TOOL_RUN_LOG = /consolelog|_stdout|_messages\.txt$|rewind_stdout|batch.*log$/i

// Real artifacts, but device/driver inventories that answer "what hardware is present" rather than
// "what happened". Kept available — a driver-loading technique may want them — but ranked last so
// they stop crowding out the artifacts that can actually corroborate an action.
const LOW_SIGNAL = /devicepnps|devicecontainers|driverpackages|drivebinaries/i

/** ATT&CK tactic → the families worth checking for it. Tactic names as ATT&CK spells them. */
const BY_TACTIC: Record<string, string[]> = {
  'initial access': ['browser', 'fileActivity', 'remoteAccess'],
  execution: ['execution', 'fileActivity'],
  persistence: ['persistence', 'execution'],
  'privilege escalation': ['execution', 'persistence'],
  // Log clearing and tampering: the deletion itself shows in file activity, the disablement in AV.
  'defense evasion': ['defense', 'fileActivity', 'execution'],
  'credential access': ['execution', 'remoteAccess'],
  discovery: ['execution'],
  // The point of lateral movement is authentication — execution artifacts are the WRONG place.
  'lateral movement': ['remoteAccess', 'fileActivity'],
  collection: ['fileActivity', 'browser'],
  'command and control': ['remoteAccess', 'browser'],
  exfiltration: ['browser', 'fileActivity', 'remoteAccess'],
  impact: ['fileActivity', 'defense']
}

/**
 * Rank un-cited sources by how plausibly they could corroborate this event.
 *
 * Sources matching a family the tactics select come first, then event logs (universal), then
 * everything else biggest-first. With no technique — or one that didn't resolve — this degrades to
 * the old behaviour: every family is plausible, so ranking falls back to size.
 */
export function corroborationCandidates(uncited: WsSource[], tactics: string[], limit = 5): WsSource[] {
  const wanted = new Set<string>()
  for (const t of tactics) for (const f of BY_TACTIC[t.trim().toLowerCase()] ?? []) wanted.add(f)

  const bySize = (a: WsSource, b: WsSource): number => b.rowCount - a.rowCount
  // No usable tactic → every family is a candidate, which is the pre-tactic behaviour.
  const families = wanted.size > 0 ? [...wanted] : Object.keys(FAMILY)
  const matches = (s: WsSource): boolean => families.some((f) => FAMILY[f].test(s.name))

  // A parser's run log can never corroborate anything, so it is dropped outright rather than ranked.
  const usable = uncited.filter((s) => !TOOL_RUN_LOG.test(s.name))
  const strong = usable.filter((s) => !LOW_SIGNAL.test(s.name))
  const weak = usable.filter((s) => LOW_SIGNAL.test(s.name))

  const tier1 = strong.filter((s) => matches(s)).sort(bySize)
  const tier2 = strong.filter((s) => !matches(s) && UNIVERSAL.test(s.name)).sort(bySize)
  const rest = strong.filter((s) => !matches(s) && !UNIVERSAL.test(s.name)).sort(bySize)
  return [...tier1, ...tier2, ...rest, ...weak.sort(bySize)].slice(0, limit)
}
