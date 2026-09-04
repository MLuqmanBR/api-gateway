import { NavLink } from 'react-router-dom'

// Segmented Chat | Embeddings | Transcription switcher shared by the three
// Models pages. Industry-standard layout: one "Models" section, modality as a
// tab — chat routing (cross-model fallback), embeddings routing (same-model,
// cross-provider fallback), and transcription routing (same-model audio
// families) are different machines behind one roof.
export function ModelsTabs() {
  const tab = (isActive: boolean) =>
    `px-3 py-1.5 text-xs rounded-lg transition-colors ${
      isActive ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
    }`
  return (
    <div className="inline-flex gap-1 rounded-xl border p-1">
      <NavLink to="/models/chat" className={({ isActive }) => tab(isActive)}>Chat models</NavLink>
      <NavLink to="/models/embeddings" className={({ isActive }) => tab(isActive)}>Embeddings</NavLink>
      <NavLink to="/models/transcriptions" className={({ isActive }) => tab(isActive)}>Transcription</NavLink>
    </div>
  )
}
