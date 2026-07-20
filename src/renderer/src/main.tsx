import React from 'react'
import { createRoot } from 'react-dom/client'
// Bundled fonts (no runtime Google Fonts fetch — keeps the build self-contained).
import '@fontsource/plus-jakarta-sans/300.css'
import '@fontsource/plus-jakarta-sans/400.css'
import '@fontsource/plus-jakarta-sans/500.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/plus-jakarta-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import './tools' // side-effect: registers every tool
import { loadTheme } from './state/theme'
import App from './App'
import { ConstellationPopout, type ConstellationPopoutPayload } from './components/ai/ConstellationPopout'
import { TimelinePopout, type TimelinePopoutPayload } from './components/ai/TimelinePopout'
import { CaseReportPopout, type CaseReportPopoutPayload } from './components/ai/CaseReportPopout'
import './styles/app.css'

// Apply the saved theme before first paint to avoid a flash.
document.documentElement.dataset.theme = loadTheme()

// A pop-out window loads the same bundle but routes (via the URL hash main set) to one feature,
// full-window, instead of the whole app. The payload rides in the hash so we render on first paint.
function readPopout(): { kind: string; payload: unknown } | null {
  const h = window.location.hash
  if (!h.startsWith('#popout=')) return null
  try {
    const data = JSON.parse(decodeURIComponent(h.slice('#popout='.length))) as { kind: string }
    return { kind: data.kind, payload: data }
  } catch {
    return null
  }
}

function Root(): JSX.Element {
  const popout = readPopout()
  if (popout?.kind === 'constellation') {
    return <ConstellationPopout payload={popout.payload as ConstellationPopoutPayload} />
  }
  if (popout?.kind === 'timeline') {
    return <TimelinePopout payload={popout.payload as TimelinePopoutPayload} />
  }
  if (popout?.kind === 'casereport') {
    return <CaseReportPopout payload={popout.payload as CaseReportPopoutPayload} />
  }
  return <App />
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
