// MITRE ATT&CK grounding for record_event. A curated catalog of common Enterprise techniques /
// sub-techniques relevant to host + endpoint DFIR, so a technique the model cites can be resolved to
// a canonical id + name + tactic instead of trusting its (often slightly-off) memory.
//
// Soft/corrective by design: a known id/name is canonicalized; a valid-format id we don't carry is
// KEPT (flagged unverified), never dropped — so a real-but-uncatalogued technique still records. The
// catalog is intentionally a subset (extend it freely); it is grounding, not an exhaustive mirror.

export interface AttackTechnique {
  id: string
  name: string
  tactic: string
}

// prettier-ignore
const CATALOG: AttackTechnique[] = [
  // Initial Access
  { id: 'T1566', name: 'Phishing', tactic: 'Initial Access' },
  { id: 'T1566.001', name: 'Spearphishing Attachment', tactic: 'Initial Access' },
  { id: 'T1566.002', name: 'Spearphishing Link', tactic: 'Initial Access' },
  { id: 'T1190', name: 'Exploit Public-Facing Application', tactic: 'Initial Access' },
  { id: 'T1133', name: 'External Remote Services', tactic: 'Initial Access' },
  { id: 'T1091', name: 'Replication Through Removable Media', tactic: 'Initial Access' },
  { id: 'T1195', name: 'Supply Chain Compromise', tactic: 'Initial Access' },
  // Execution
  { id: 'T1059', name: 'Command and Scripting Interpreter', tactic: 'Execution' },
  { id: 'T1059.001', name: 'PowerShell', tactic: 'Execution' },
  { id: 'T1059.003', name: 'Windows Command Shell', tactic: 'Execution' },
  { id: 'T1059.005', name: 'Visual Basic', tactic: 'Execution' },
  { id: 'T1059.006', name: 'Python', tactic: 'Execution' },
  { id: 'T1059.007', name: 'JavaScript', tactic: 'Execution' },
  { id: 'T1204', name: 'User Execution', tactic: 'Execution' },
  { id: 'T1204.002', name: 'Malicious File', tactic: 'Execution' },
  { id: 'T1047', name: 'Windows Management Instrumentation', tactic: 'Execution' },
  { id: 'T1053', name: 'Scheduled Task/Job', tactic: 'Execution' },
  { id: 'T1053.005', name: 'Scheduled Task', tactic: 'Execution' },
  { id: 'T1569', name: 'System Services', tactic: 'Execution' },
  { id: 'T1569.002', name: 'Service Execution', tactic: 'Execution' },
  { id: 'T1106', name: 'Native API', tactic: 'Execution' },
  { id: 'T1129', name: 'Shared Modules', tactic: 'Execution' },
  // Persistence
  { id: 'T1547', name: 'Boot or Logon Autostart Execution', tactic: 'Persistence' },
  { id: 'T1547.001', name: 'Registry Run Keys / Startup Folder', tactic: 'Persistence' },
  { id: 'T1543', name: 'Create or Modify System Process', tactic: 'Persistence' },
  { id: 'T1543.003', name: 'Windows Service', tactic: 'Persistence' },
  { id: 'T1136', name: 'Create Account', tactic: 'Persistence' },
  { id: 'T1136.001', name: 'Local Account', tactic: 'Persistence' },
  { id: 'T1505', name: 'Server Software Component', tactic: 'Persistence' },
  { id: 'T1505.003', name: 'Web Shell', tactic: 'Persistence' },
  { id: 'T1546', name: 'Event Triggered Execution', tactic: 'Persistence' },
  { id: 'T1546.003', name: 'Windows Management Instrumentation Event Subscription', tactic: 'Persistence' },
  { id: 'T1574', name: 'Hijack Execution Flow', tactic: 'Persistence' },
  { id: 'T1574.002', name: 'DLL Side-Loading', tactic: 'Persistence' },
  { id: 'T1574.001', name: 'DLL Search Order Hijacking', tactic: 'Persistence' },
  { id: 'T1197', name: 'BITS Jobs', tactic: 'Persistence' },
  { id: 'T1078', name: 'Valid Accounts', tactic: 'Persistence' },
  // Privilege Escalation
  { id: 'T1548', name: 'Abuse Elevation Control Mechanism', tactic: 'Privilege Escalation' },
  { id: 'T1548.002', name: 'Bypass User Account Control', tactic: 'Privilege Escalation' },
  { id: 'T1134', name: 'Access Token Manipulation', tactic: 'Privilege Escalation' },
  { id: 'T1068', name: 'Exploitation for Privilege Escalation', tactic: 'Privilege Escalation' },
  { id: 'T1055', name: 'Process Injection', tactic: 'Privilege Escalation' },
  // Defense Evasion
  { id: 'T1562', name: 'Impair Defenses', tactic: 'Defense Evasion' },
  { id: 'T1562.001', name: 'Disable or Modify Tools', tactic: 'Defense Evasion' },
  { id: 'T1562.002', name: 'Disable Windows Event Logging', tactic: 'Defense Evasion' },
  { id: 'T1562.004', name: 'Disable or Modify System Firewall', tactic: 'Defense Evasion' },
  { id: 'T1070', name: 'Indicator Removal', tactic: 'Defense Evasion' },
  { id: 'T1070.001', name: 'Clear Windows Event Logs', tactic: 'Defense Evasion' },
  { id: 'T1070.004', name: 'File Deletion', tactic: 'Defense Evasion' },
  { id: 'T1027', name: 'Obfuscated Files or Information', tactic: 'Defense Evasion' },
  { id: 'T1140', name: 'Deobfuscate/Decode Files or Information', tactic: 'Defense Evasion' },
  { id: 'T1112', name: 'Modify Registry', tactic: 'Defense Evasion' },
  { id: 'T1036', name: 'Masquerading', tactic: 'Defense Evasion' },
  { id: 'T1036.005', name: 'Match Legitimate Name or Location', tactic: 'Defense Evasion' },
  { id: 'T1218', name: 'System Binary Proxy Execution', tactic: 'Defense Evasion' },
  { id: 'T1218.011', name: 'Rundll32', tactic: 'Defense Evasion' },
  { id: 'T1218.005', name: 'Mshta', tactic: 'Defense Evasion' },
  { id: 'T1218.010', name: 'Regsvr32', tactic: 'Defense Evasion' },
  { id: 'T1497', name: 'Virtualization/Sandbox Evasion', tactic: 'Defense Evasion' },
  { id: 'T1564', name: 'Hide Artifacts', tactic: 'Defense Evasion' },
  { id: 'T1620', name: 'Reflective Code Loading', tactic: 'Defense Evasion' },
  { id: 'T1127', name: 'Trusted Developer Utilities Proxy Execution', tactic: 'Defense Evasion' },
  // Credential Access
  { id: 'T1003', name: 'OS Credential Dumping', tactic: 'Credential Access' },
  { id: 'T1003.001', name: 'LSASS Memory', tactic: 'Credential Access' },
  { id: 'T1003.002', name: 'Security Account Manager', tactic: 'Credential Access' },
  { id: 'T1003.003', name: 'NTDS', tactic: 'Credential Access' },
  { id: 'T1110', name: 'Brute Force', tactic: 'Credential Access' },
  { id: 'T1110.001', name: 'Password Guessing', tactic: 'Credential Access' },
  { id: 'T1110.003', name: 'Password Spraying', tactic: 'Credential Access' },
  { id: 'T1555', name: 'Credentials from Password Stores', tactic: 'Credential Access' },
  { id: 'T1555.003', name: 'Credentials from Web Browsers', tactic: 'Credential Access' },
  { id: 'T1552', name: 'Unsecured Credentials', tactic: 'Credential Access' },
  { id: 'T1056', name: 'Input Capture', tactic: 'Credential Access' },
  { id: 'T1056.001', name: 'Keylogging', tactic: 'Credential Access' },
  { id: 'T1558', name: 'Steal or Forge Kerberos Tickets', tactic: 'Credential Access' },
  { id: 'T1558.003', name: 'Kerberoasting', tactic: 'Credential Access' },
  // Discovery
  { id: 'T1087', name: 'Account Discovery', tactic: 'Discovery' },
  { id: 'T1018', name: 'Remote System Discovery', tactic: 'Discovery' },
  { id: 'T1082', name: 'System Information Discovery', tactic: 'Discovery' },
  { id: 'T1083', name: 'File and Directory Discovery', tactic: 'Discovery' },
  { id: 'T1057', name: 'Process Discovery', tactic: 'Discovery' },
  { id: 'T1016', name: 'System Network Configuration Discovery', tactic: 'Discovery' },
  { id: 'T1049', name: 'System Network Connections Discovery', tactic: 'Discovery' },
  { id: 'T1033', name: 'System Owner/User Discovery', tactic: 'Discovery' },
  { id: 'T1518', name: 'Software Discovery', tactic: 'Discovery' },
  { id: 'T1518.001', name: 'Security Software Discovery', tactic: 'Discovery' },
  { id: 'T1046', name: 'Network Service Discovery', tactic: 'Discovery' },
  { id: 'T1135', name: 'Network Share Discovery', tactic: 'Discovery' },
  { id: 'T1007', name: 'System Service Discovery', tactic: 'Discovery' },
  { id: 'T1012', name: 'Query Registry', tactic: 'Discovery' },
  // Lateral Movement
  { id: 'T1021', name: 'Remote Services', tactic: 'Lateral Movement' },
  { id: 'T1021.001', name: 'Remote Desktop Protocol', tactic: 'Lateral Movement' },
  { id: 'T1021.002', name: 'SMB/Windows Admin Shares', tactic: 'Lateral Movement' },
  { id: 'T1021.004', name: 'SSH', tactic: 'Lateral Movement' },
  { id: 'T1021.006', name: 'Windows Remote Management', tactic: 'Lateral Movement' },
  { id: 'T1570', name: 'Lateral Tool Transfer', tactic: 'Lateral Movement' },
  { id: 'T1550', name: 'Use Alternate Authentication Material', tactic: 'Lateral Movement' },
  { id: 'T1550.002', name: 'Pass the Hash', tactic: 'Lateral Movement' },
  // Collection
  { id: 'T1560', name: 'Archive Collected Data', tactic: 'Collection' },
  { id: 'T1560.001', name: 'Archive via Utility', tactic: 'Collection' },
  { id: 'T1005', name: 'Data from Local System', tactic: 'Collection' },
  { id: 'T1114', name: 'Email Collection', tactic: 'Collection' },
  { id: 'T1113', name: 'Screen Capture', tactic: 'Collection' },
  { id: 'T1115', name: 'Clipboard Data', tactic: 'Collection' },
  { id: 'T1074', name: 'Data Staged', tactic: 'Collection' },
  // Command and Control
  { id: 'T1071', name: 'Application Layer Protocol', tactic: 'Command and Control' },
  { id: 'T1071.001', name: 'Web Protocols', tactic: 'Command and Control' },
  { id: 'T1105', name: 'Ingress Tool Transfer', tactic: 'Command and Control' },
  { id: 'T1219', name: 'Remote Access Software', tactic: 'Command and Control' },
  { id: 'T1090', name: 'Proxy', tactic: 'Command and Control' },
  { id: 'T1573', name: 'Encrypted Channel', tactic: 'Command and Control' },
  { id: 'T1572', name: 'Protocol Tunneling', tactic: 'Command and Control' },
  { id: 'T1568', name: 'Dynamic Resolution', tactic: 'Command and Control' },
  { id: 'T1095', name: 'Non-Application Layer Protocol', tactic: 'Command and Control' },
  { id: 'T1102', name: 'Web Service', tactic: 'Command and Control' },
  // Exfiltration
  { id: 'T1041', name: 'Exfiltration Over C2 Channel', tactic: 'Exfiltration' },
  { id: 'T1048', name: 'Exfiltration Over Alternative Protocol', tactic: 'Exfiltration' },
  { id: 'T1567', name: 'Exfiltration Over Web Service', tactic: 'Exfiltration' },
  { id: 'T1567.002', name: 'Exfiltration to Cloud Storage', tactic: 'Exfiltration' },
  { id: 'T1029', name: 'Scheduled Transfer', tactic: 'Exfiltration' },
  // Impact
  { id: 'T1486', name: 'Data Encrypted for Impact', tactic: 'Impact' },
  { id: 'T1490', name: 'Inhibit System Recovery', tactic: 'Impact' },
  { id: 'T1489', name: 'Service Stop', tactic: 'Impact' },
  { id: 'T1485', name: 'Data Destruction', tactic: 'Impact' },
  { id: 'T1491', name: 'Defacement', tactic: 'Impact' },
  { id: 'T1529', name: 'System Shutdown/Reboot', tactic: 'Impact' },
  { id: 'T1531', name: 'Account Access Removal', tactic: 'Impact' }
]

const BY_ID = new Map(CATALOG.map((t) => [t.id, t]))
const ID_IN_TEXT = /T\d{4}(?:\.\d{3})?/i

export interface ResolvedTechnique {
  id: string | null
  name: string
  tactic: string | null
  verified: boolean
  /** One-line canonical form for storage/display. */
  display: string
}

function stripId(text: string): string {
  return text
    .replace(ID_IN_TEXT, '')
    .replace(/^[\s:—–-]+/, '')
    .replace(/[\s:—–-]+$/, '')
    .trim()
}

/** Resolve a model-supplied technique (an id, "id — name", or a name) against the catalog. */
export function resolveTechnique(input: string): ResolvedTechnique | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null

  const idMatch = raw.match(ID_IN_TEXT)
  if (idMatch) {
    const id = idMatch[0].toUpperCase()
    const hit = BY_ID.get(id)
    if (hit) return { id: hit.id, name: hit.name, tactic: hit.tactic, verified: true, display: `${hit.id} — ${hit.name} (${hit.tactic})` }
    const name = stripId(raw)
    return { id, name: name || id, tactic: null, verified: false, display: `${id}${name ? ` — ${name}` : ''} (unverified)` }
  }

  // No id → match by name (exact, then either-contains).
  const lc = raw.toLowerCase()
  const byName =
    CATALOG.find((t) => t.name.toLowerCase() === lc) ??
    CATALOG.find((t) => t.name.toLowerCase().includes(lc) || lc.includes(t.name.toLowerCase()))
  if (byName) return { id: byName.id, name: byName.name, tactic: byName.tactic, verified: true, display: `${byName.id} — ${byName.name} (${byName.tactic})` }
  return { id: null, name: raw, tactic: null, verified: false, display: `${raw} (unverified)` }
}
