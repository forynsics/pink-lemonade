import React from 'react'
import { createRoot } from 'react-dom/client'
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
