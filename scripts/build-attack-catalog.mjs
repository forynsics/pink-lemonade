// Regenerates src/main/ai/attackCatalog.json from MITRE's official ATT&CK STIX data.
//
// Run manually when a new ATT&CK version ships (roughly twice a year — far less often than we
// release, which is why the catalog is baked at build time instead of fetched at runtime):
//
//   npm run build:attack
//
// The upstream Enterprise bundle is ~51 MB of STIX; everything we need distills to ~55 KB, so the
// generated JSON is committed and imported directly. No network access at runtime or in CI.
//
// Usage: node scripts/build-attack-catalog.mjs [--src <path-to-enterprise-attack.json>]
// Without --src it downloads the current bundle.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const BUNDLE_URL = 'https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'ai', 'attackCatalog.json')

const srcFlag = process.argv.indexOf('--src')
const srcPath = srcFlag !== -1 ? process.argv[srcFlag + 1] : null

async function loadBundle() {
  if (srcPath) {
    console.log(`reading ${srcPath}`)
    return JSON.parse(readFileSync(srcPath, 'utf8'))
  }
  console.log(`downloading ${BUNDLE_URL} (~51 MB)…`)
  const res = await fetch(BUNDLE_URL)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  return JSON.parse(await res.text())
}

const attackId = (o) => (o.external_references ?? []).find((r) => r.source_name === 'mitre-attack')?.external_id
const isLive = (o) => !o.revoked && !o.x_mitre_deprecated

const bundle = await loadBundle()
const objects = bundle.objects ?? []
const byStixId = new Map(objects.map((o) => [o.id, o]))

// Tactic shortnames (as used by kill_chain_phases) -> display names. Read from the bundle rather
// than title-cased, because ATT&CK renames them: v19 turned 'defense-evasion' into 'Stealth' and
// added 'Defense Impairment'.
const tacticName = new Map()
for (const o of objects) {
  if (o.type === 'x-mitre-tactic' && isLive(o) && o.x_mitre_shortname) tacticName.set(o.x_mitre_shortname, o.name)
}

const patterns = objects.filter((o) => o.type === 'attack-pattern')

const techniques = patterns
  .filter((o) => isLive(o) && attackId(o))
  .map((o) => ({
    id: attackId(o),
    name: o.name,
    // A technique can sit under several tactics (145 of them do). Source order is kept — it's
    // stable across releases, so the generated file diffs cleanly.
    tactics: (o.kill_chain_phases ?? [])
      .filter((k) => k.kill_chain_name === 'mitre-attack')
      .map((k) => tacticName.get(k.phase_name) ?? k.phase_name)
  }))
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const liveIds = new Set(techniques.map((t) => t.id))

// Retired ids -> their replacement. ATT&CK renumbers techniques (T1562.001 became T1685), and a
// model's training data still cites the old id, so this is what lets us correct it instead of
// flagging a real technique as unverified.
const direct = new Map()
for (const r of objects) {
  if (r.type !== 'relationship' || r.relationship_type !== 'revoked-by') continue
  const from = byStixId.get(r.source_ref)
  const to = byStixId.get(r.target_ref)
  if (from?.type !== 'attack-pattern' || !to) continue
  const a = attackId(from)
  const b = attackId(to)
  if (a && b && a !== b) direct.set(a, b)
}

// Replacements can chain (T1150 -> T1547.011 -> T1647), so follow each to a live technique.
const superseded = {}
for (const [from] of direct) {
  const seen = new Set([from])
  let to = direct.get(from)
  while (to && !liveIds.has(to) && direct.has(to) && !seen.has(to)) {
    seen.add(to)
    to = direct.get(to)
  }
  if (to && liveIds.has(to)) superseded[from] = to
  else console.warn(`  ! dropping ${from}: chain ends at ${to ?? '(nothing)'}, which is not a live technique`)
}

const collection = objects.find((o) => o.type === 'x-mitre-collection')
const out = {
  _generated: 'npm run build:attack — do not edit by hand. Source: MITRE ATT&CK STIX (CC BY 4.0).',
  version: collection?.x_mitre_version ?? 'unknown',
  modified: (collection?.modified ?? '').slice(0, 10),
  techniques,
  superseded: Object.fromEntries(Object.entries(superseded).sort(([a], [b]) => (a < b ? -1 : 1)))
}

writeFileSync(OUT, JSON.stringify(out, null, 0) + '\n', 'utf8')

const multi = techniques.filter((t) => t.tactics.length > 1).length
const subs = techniques.filter((t) => t.id.includes('.')).length
console.log(`\nATT&CK v${out.version} (modified ${out.modified})`)
console.log(`  techniques : ${techniques.length} live (${subs} sub-techniques, ${multi} multi-tactic)`)
console.log(`  superseded : ${Object.keys(out.superseded).length} retired ids mapped to current ones`)
console.log(`  tactics    : ${tacticName.size}`)
console.log(`  wrote      : ${OUT} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)`)
