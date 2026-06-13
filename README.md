# 🍋 pink-lemonade

A local, offline desktop "swiss army knife" for cybersecurity investigations and data
parsing. Paste a blob, run one or more operations, copy the result — no pivoting to
Notepad++ or pasting sensitive data into web tools.

Built with Electron + React + TypeScript. Everything runs locally; the app makes no
network requests.

## Features (MVP)

**Text transforms** — Base64 encode/decode, hex encode/decode, URL encode/decode,
deduplicate lines, clean whitespace, change case.

**IOC extractors** — pull IPv4 (public by default, private optional), domains, URLs,
emails, and MD5/SHA1/SHA256 hashes out of any text. Defanged indicators
(`hxxp`, `1[.]2[.]3[.]4`) are refanged automatically before extraction.

**Recipe chaining** — pick tools from the palette to build a pipeline; each step feeds the
next (e.g. *Base64 Decode → Extract IPv4 → Deduplicate*).

## Develop

```bash
npm install
npm run dev        # launch with hot reload
npm test           # run unit tests
npm run typecheck  # type-check main + renderer
```

## Package (Windows)

```bash
npm run dist       # builds and produces an NSIS installer (.exe) in dist/
```

## Roadmap

- SIEM query builder (join lines with `OR`, quote/field templating, `\r\n` → `OR`)
- Defang / refang tool
- v2: API enrichment (VirusTotal, AbuseIPDB, …) via an `EnrichmentProvider` seam, with
  secrets in the OS keychain and network calls confined to the main process.

See `CLAUDE.md` for architecture details.
