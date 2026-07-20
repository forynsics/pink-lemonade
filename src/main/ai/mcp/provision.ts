// Provisions the investigation working directory the analyst runs `claude` from. It contains
// everything Claude Code needs to drive the app, so setup is one button + `cd <dir> && claude`:
//   • .mcp.json               — points Claude Code at the localhost MCP server (URL + bearer token)
//   • CLAUDE.md               — the retained investigation methodology (the reliable way to deliver it)
//   • .claude/settings.local.json — pre-approves the non-gated tools so they don't prompt per call
//   • .gitignore              — the folder carries a localhost token; keep it out of any repo
//
// The MCP `instructions` field is NOT reliably surfaced by Claude Code and MCP prompts aren't
// implemented there, so CLAUDE.md on disk is how the methodology travels — one source of truth
// (GROUNDING_RULES) — the app's own copy of the methodology.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as dbw from '../../csv/dbClient'
import { GROUNDING_RULES } from '../prompt'
import { getMcpStatus } from './server'

const FOLDER_NAME = 'pink-lemonade-terminal'

/** Default location for the working folder — beside the analyst's workspaces. */
export async function defaultFolder(): Promise<string> {
  const wsDir = await dbw.call<string>('getWorkspaceDir')
  return join(wsDir, FOLDER_NAME)
}

function mcpJson(url: string, token: string): string {
  return (
    JSON.stringify(
      {
        mcpServers: {
          pinklemonade: {
            type: 'http',
            url,
            headers: { Authorization: `Bearer ${token}` },
            // 10 min: a long distinct/count scan can run past the default 5-min idle abort.
            timeout: 600000
          }
        }
      },
      null,
      2
    ) + '\n'
  )
}

function claudeMd(): string {
  return `# Investigating with pink-lemonade

You are driving **pink-lemonade**, a desktop cybersecurity-investigation app, from this terminal. Its
workspace tools are exposed to you as the \`pinklemonade\` MCP server — you operate the workspace the
analyst has open in the app, and everything you record (events, IOCs, tags, plan) shows up live in the
app's Constellation / Timeline / IOC / Investigation panels for the analyst to review.

${AGENT_LINE}

## How to work

- The app must be running. **Call \`list_sources\` first** to see what is already open. If no case is
  open, you can build one yourself: \`list_workspaces\` → \`use_workspace\` to resume an existing case,
  or \`create_case\` + \`list_evidence\` + \`import_evidence\` to start a new one from the analyst's
  evidence folder.
- **Resuming?** Call \`get_investigation_state\` first (then \`list_events\` / \`list_iocs\`) to recover the
  saved plan, progress note, and what you've already recorded — continue from there, don't re-derive.
- **Three tools ask you to confirm in this terminal, every time**: \`import_evidence\` (it pulls files
  off disk into the case) and \`tag_rows\` / \`set_source_group\` (they change analyst-facing verdicts).
  Everything else runs without a prompt.
- If one of those three is DENIED, that is the analyst declining — **not** a bug, and not something to
  retry. Retrying an unapproved call just burns turns. Say plainly which call was refused and what you
  wanted it for, then continue with what you can do, or stop and ask. If you are running unattended
  with nobody to approve, say so and stop rather than working around it.
- \`import_evidence\` normally takes \`hosts\`, not file paths: it imports EVERY artifact those hosts
  produced. Do not pre-select what looks relevant — you cannot know which artifact answers the question
  before you read it. Import in ONE call; each call costs the analyst a separate approval.

${GROUNDING_RULES}
`
}

// How the agent should carry itself, phrased for the terminal context.
const AGENT_LINE =
  'Work as the analyst’s investigative agent: triage and reason about the open data, ground every claim in a tool result, and leave the analyst in control of any verdict.'

export interface ProvisionResult {
  dir: string
  port: number | null
}

/** Write (or refresh) the working folder. Overwrites the generated files so a rotated token/port or an
 *  updated methodology propagates on the next setup. */
export async function provisionFolder(dir: string): Promise<ProvisionResult> {
  const status = getMcpStatus()
  if (!status.running || !status.url || !status.token) throw new Error('The MCP server is not running yet.')
  await mkdir(join(dir, '.claude'), { recursive: true })
  await writeFile(join(dir, '.mcp.json'), mcpJson(status.url, status.token), 'utf8')
  await writeFile(join(dir, 'CLAUDE.md'), claudeMd(), 'utf8')
  await writeFile(
    join(dir, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['mcp__pinklemonade__*'] } }, null, 2) + '\n',
    'utf8'
  )
  await writeFile(join(dir, '.gitignore'), '.mcp.json\n.claude/settings.local.json\n', 'utf8')
  return { dir, port: status.port }
}
