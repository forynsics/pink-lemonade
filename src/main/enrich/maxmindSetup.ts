// Downloads + installs MaxMind GeoLite2 databases for the user (runs in the MAIN process — it's
// network + fs, not SQLite). MaxMind can't be bundled or fetched anonymously (their rule since
// 2019), so this uses the user's own free license key. The .tar.gz is streamed, auto-gunzipped,
// and the .mmdb is extracted to <userData>/geoip/<edition>.mmdb. This is the app's first network
// egress — opt-in, only when the user clicks "Download" with a key they supplied.

import { mkdirSync, existsSync, createWriteStream, unlinkSync } from 'fs'
import { join } from 'path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'

/** The two GeoLite2 editions we install: City (geo) + ASN (network owner/org). */
export const DEFAULT_EDITIONS = ['GeoLite2-City', 'GeoLite2-ASN'] as const

export function buildDownloadUrl(editionId: string, licenseKey: string): string {
  const q = new URLSearchParams({ edition_id: editionId, license_key: licenseKey, suffix: 'tar.gz' })
  return `https://download.maxmind.com/app/geoip_download?${q.toString()}`
}

export interface DownloadProgress {
  editionId: string
  received: number
  total: number
}

/** Download one edition's tar.gz, extract its .mmdb to <destDir>/<editionId>.mmdb, return the path. */
export async function downloadEdition(
  editionId: string,
  licenseKey: string,
  destDir: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  const res = await fetch(buildDownloadUrl(editionId, licenseKey))
  if (res.status === 401) throw new Error('Invalid MaxMind license key')
  if (!res.ok || !res.body) throw new Error(`Download failed for ${editionId} (HTTP ${res.status})`)

  mkdirSync(destDir, { recursive: true })
  const total = Number(res.headers.get('content-length') ?? 0)
  const tmp = join(destDir, `${editionId}.tar.gz.part`)

  // 1) Stream the .tar.gz to a temp file. Bytes are counted in a Transform (not a 'data' listener),
  //    so progress reporting never disturbs the stream or its backpressure.
  let received = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length
      onProgress?.({ editionId, received, total })
      cb(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(tmp))

  // 2) Extract the .mmdb from the archive on disk (tar auto-detects gzip), dropping the dated top
  //    folder (strip:1) → lands at <destDir>/GeoLite2-<Ed>.mmdb. Then remove the temp archive.
  try {
    await tar.x({ file: tmp, cwd: destDir, strip: 1, filter: (p: string) => p.endsWith('.mmdb') })
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }

  const out = join(destDir, `${editionId}.mmdb`)
  if (!existsSync(out)) throw new Error(`No .mmdb found in the ${editionId} archive`)
  return out
}
