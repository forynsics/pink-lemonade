// The IOC taxonomy — the SINGLE definition, read by both the AI toolbox (main) and the IOC panel
// (renderer).
//
// This used to be two copies, one per project, with a silent failure mode: the panel renders
// `TYPE_ORDER.filter(present)`, so a type the agent could record but the panel didn't know was stored
// correctly in the workspace and never drawn. Nothing errored. `src/shared` exists so vocabularies
// like this have one home — it is included by BOTH tsconfigs and must stay free of any Node, Electron
// or DOM dependency, since it is bundled into the sandboxed renderer as well as the main process.

/** Canonical type id → display label. Insertion order IS the section order in the IOC panel:
 *  identity and network indicators first, host-local artifacts next, forensic minutiae last. */
export const IOC_TYPES: Record<string, string> = {
  ip: 'IP', domain: 'Domain', url: 'URL', email: 'Email', hash: 'File Hash', account: 'Account',
  filename: 'Filename', filepath: 'File Path', process: 'Process', commandline: 'Command Line', useragent: 'User Agent', cloud: 'Cloud Identifier',
  registry: 'Registry', service: 'Service', scheduledtask: 'Scheduled Task', mutex: 'Mutex', namedpipe: 'Named Pipe', tlsfingerprint: 'TLS Fingerprint', certificate: 'Certificate', pdbpath: 'PDB Path'
}

/** Section order for the panel — derived, so it can never disagree with the labels. */
export const TYPE_ORDER = Object.keys(IOC_TYPES)

/** Types an enrichment provider can actually look up — "Send to Intel" only offers these. An account
 *  is a first-class IOC but nothing enriches it, so it is deliberately absent. */
export const ENRICHABLE = new Set(['ip', 'domain', 'url', 'email', 'hash'])

/** Loose aliases → canonical id, so a model's phrasing still lands in the right bucket. */
export const IOC_SYNONYMS: Record<string, string> = {
  ipv4: 'ip', ipv6: 'ip', ipaddress: 'ip', address: 'ip',
  md5: 'hash', sha1: 'hash', sha256: 'hash', filehash: 'hash', sha: 'hash',
  // `host`/`hostname` mean the DNS name of something. A VICTIM hostname is not an indicator anyone
  // would hunt or share — it is a subject of the case, and belongs to the Systems entity model.
  fqdn: 'domain', hostname: 'domain', host: 'domain',
  // Identity. An intrusion is usually driven by ONE compromised account, and it is the thread tying
  // otherwise-unrelated hosts together — so it needs a type of its own rather than being filed under
  // `process`, which is what happened and which misleads anyone reading the IOC list.
  user: 'account', username: 'account', useraccount: 'account', samaccountname: 'account',
  upn: 'account', principal: 'account', login: 'account', logon: 'account', sid: 'account',
  serviceaccount: 'account', credential: 'account',
  path: 'filepath', file: 'filename',
  cmd: 'commandline', cmdline: 'commandline', command: 'commandline',
  ua: 'useragent',
  ja3: 'tlsfingerprint', jarm: 'tlsfingerprint', tls: 'tlsfingerprint', fingerprint: 'tlsfingerprint',
  cert: 'certificate', thumbprint: 'certificate',
  task: 'scheduledtask', scheduled: 'scheduledtask',
  pipe: 'namedpipe',
  reg: 'registry', regkey: 'registry', registrykey: 'registry',
  svc: 'service',
  appid: 'cloud', tenantid: 'cloud', accesskey: 'cloud', accesskeyid: 'cloud',
  pdb: 'pdbpath'
}

/** Normalize a model-supplied IOC type to a canonical taxonomy id, tolerating case + synonyms. */
export function normalizeIocType(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!s) return null
  return IOC_TYPES[s] ? s : (IOC_SYNONYMS[s] ?? null)
}
