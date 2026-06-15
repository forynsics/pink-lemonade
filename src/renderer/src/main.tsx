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
import './styles/app.css'

// Apply the saved theme before first paint to avoid a flash.
document.documentElement.dataset.theme = loadTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
