import { describe, it, expect } from 'vitest'
import { corroborationCandidates } from './corroborate'
import type { WsSource } from './types'

const src = (name: string, rowCount = 100): WsSource => ({
  sourceId: name.length,
  tabId: `w:${name}`,
  name,
  columns: [],
  rowCount
})

// A realistic KAPE spread, in no useful order.
const SOURCES = [
  src('20250327164059_Amcache_AssociatedFileEntries.csv', 9000),
  src('20250327164059_Amcache_DriveBinaries.csv', 8000),
  src('Windows10Creators_SYSTEM_AppCompatCache.csv', 500),
  src('20250327234110_MFTECmd_$MFT_Output.csv', 195000),
  src('USNJRNL.fullPaths.csv', 120000),
  src('20250327234218_LECmd_Output.csv', 46),
  src('user1_UsrClass.csv', 300),
  src('hayabusa_events_offline.csv', 2288),
  src('20250327234131_EvtxECmd_Output.csv', 50000),
  src('Microsoft_WindowsDefender_MPLog-20250318.csv', 700),
  src('Hindsight_output.xlsx — Timeline', 264)
]

const names = (out: WsSource[]): string[] => out.map((s) => s.name)

describe('corroborationCandidates', () => {
  // The reported failure: for a pass-the-hash NETWORK LOGON the nudge suggested Amcache,
  // AppCompatCache and Amcache_DriveBinaries — artifacts of local execution, which cannot evidence a
  // logon. The agent stopped reading the field entirely.
  it('does not lead with execution artifacts for lateral movement', () => {
    const out = names(corroborationCandidates(SOURCES, ['Lateral Movement']))
    expect(out[0]).not.toMatch(/Amcache|AppCompat/i)
    expect(out.some((n) => /Amcache_DriveBinaries/i.test(n))).toBe(false)
  })

  it('leads with authentication and shell-trace artifacts for lateral movement', () => {
    const out = names(corroborationCandidates(SOURCES, ['Lateral Movement'], 4))
    // MFT/USN/LNK/UsrClass (shellbags) evidence remote share use; event logs carry the logons.
    expect(out.some((n) => /MFT|USNJRNL|LECmd|UsrClass/i.test(n))).toBe(true)
  })

  it('DOES lead with execution artifacts for an execution technique', () => {
    const out = names(corroborationCandidates(SOURCES, ['Execution'], 3))
    expect(out.some((n) => /Amcache|AppCompat/i.test(n))).toBe(true)
  })

  it('offers AV telemetry for defense evasion', () => {
    const out = names(corroborationCandidates(SOURCES, ['Defense Evasion'], 5))
    expect(out.some((n) => /MPLog|Defender/i.test(n))).toBe(true)
  })

  it('offers browser history for command and control', () => {
    const out = names(corroborationCandidates(SOURCES, ['Command and Control'], 5))
    expect(out.some((n) => /Hindsight/i.test(n))).toBe(true)
  })

  it('is case- and spacing-insensitive about tactic names', () => {
    expect(names(corroborationCandidates(SOURCES, ['lateral movement']))).toEqual(
      names(corroborationCandidates(SOURCES, ['  Lateral Movement  ']))
    )
  })

  // Event logs corroborate almost anything, so they should stay available rather than being filtered
  // out by a tactic that didn't name them.
  it('keeps event logs in play for any tactic', () => {
    const out = names(corroborationCandidates(SOURCES, ['Discovery'], 11))
    expect(out.some((n) => /hayabusa|EvtxECmd/i.test(n))).toBe(true)
  })

  it('falls back to size-ranked plausible artifacts when the technique did not resolve', () => {
    const out = corroborationCandidates(SOURCES, [], 3)
    expect(out.length).toBe(3)
    // Still ranked, not arbitrary — biggest plausible artifact first.
    expect(out[0].rowCount).toBeGreaterThanOrEqual(out[1].rowCount)
  })

  it('never suggests more than the limit, and nothing when everything is cited', () => {
    expect(corroborationCandidates(SOURCES, ['Execution'], 2)).toHaveLength(2)
    expect(corroborationCandidates([], ['Execution'])).toEqual([])
  })

  it('still returns something when no source matches any family', () => {
    const odd = [src('notes.csv', 5), src('random_export.csv', 9)]
    expect(corroborationCandidates(odd, ['Lateral Movement'])).toHaveLength(2)
  })
})

describe('noise suppression', () => {
  const NOISY = [
    src('!SBECmd_Messages.txt', 12),
    src('usnjrnl_rewind_stdout.log', 40),
    src('DFIRBatch_RECmdConsoleLog.txt', 30),
    src('20250327164059_Amcache_DriveBinaries.csv', 8000),
    src('20250327164059_Amcache_DevicePnps.csv', 5000),
    src('20250327234110_MFTECmd_$MFT_Output.csv', 195000)
  ]

  // A parser's own run log records that a KAPE module executed — never what happened on the host.
  it('never suggests tool run logs', () => {
    const out = names(corroborationCandidates(NOISY, ['Lateral Movement'], 6))
    expect(out.some((n) => /Messages\.txt|_stdout|ConsoleLog/i.test(n))).toBe(false)
  })

  // "Nearly always irrelevant" per the agent — a driver inventory answers what hardware is present.
  it('ranks device and driver inventories last, without hiding them', () => {
    const out = names(corroborationCandidates(NOISY, ['Execution'], 6))
    expect(out[0]).toMatch(/MFT/i)
    expect(out.some((n) => /DriveBinaries|DevicePnps/i.test(n))).toBe(true)
    expect(out.indexOf('20250327164059_Amcache_DriveBinaries.csv')).toBeGreaterThan(0)
  })

  it('returns nothing rather than noise when only run logs remain', () => {
    const onlyLogs = [src('!SBECmd_Messages.txt', 12), src('tool_stdout.log', 5)]
    expect(corroborationCandidates(onlyLogs, ['Execution'])).toEqual([])
  })
})
