import type { ReactNode } from 'react'
import { LayoutGridIcon, RefreshCwIcon, ScanLineIcon } from './NavIcons'

export type NavKey = 'sessions' | 'scanner' | 'sync'
export type NavTarget = { name: 'sessions' } | { name: 'scanner'; sessionId?: string } | { name: 'sync' }

export const NAV_ITEMS: Array<{ key: NavKey; label: string; icon: ReactNode }> = [
  { key: 'sessions', label: 'Sesiones', icon: <LayoutGridIcon /> },
  { key: 'scanner', label: 'Escanear', icon: <ScanLineIcon /> },
  { key: 'sync', label: 'Sincronizar', icon: <RefreshCwIcon /> }
]

/** Pantalla a la que lleva cada opción. Solo navega: nunca ejecuta sincronización, escaneo ni cambios de datos. */
export const viewForNav = (key: NavKey, currentSessionId?: string): NavTarget =>
  key === 'scanner' ? { name: 'scanner', sessionId: currentSessionId } : key === 'sync' ? { name: 'sync' } : { name: 'sessions' }

/** Opción resaltada según la pantalla actual (las pantallas de inventario, formulario y detalle pertenecen a «Sesiones»). */
export const activeNavKey = (viewName: string): NavKey | null =>
  ['sessions', 'inventory', 'form', 'detail'].includes(viewName) ? 'sessions' : viewName === 'scanner' ? 'scanner' : viewName === 'sync' ? 'sync' : null

interface Props {
  viewName: string
  onSelect: (key: NavKey) => void
}

export function BottomNav({ viewName, onSelect }: Props) {
  const active = activeNavKey(viewName)
  return <nav className="bottom-nav" aria-label="Navegación principal">
    {NAV_ITEMS.map((item) => <button
      key={item.key}
      type="button"
      className={item.key === active ? 'active' : ''}
      aria-current={item.key === active ? 'page' : undefined}
      onClick={() => onSelect(item.key)}
    >
      <span className="nav-icon">{item.icon}</span>
      <span className="nav-label">{item.label}</span>
    </button>)}
  </nav>
}
