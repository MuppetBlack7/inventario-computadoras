import { readFileSync } from 'node:fs'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { activeNavKey, BottomNav, NAV_ITEMS, viewForNav, type NavKey } from './components/BottomNav'
import { SyncAlertBar } from './components/SyncAlertBar'
import { computeSyncAlert, type SyncAlertInput } from './syncAlert'

const healthy: SyncAlertInput = { signedIn: true, syncHeld: false, online: true, firebaseReachable: true, pending: 0, failedOperations: 0, photoProblems: 0, lastSyncFailed: false }
const input = (change: Partial<SyncAlertInput> = {}): SyncAlertInput => ({ ...healthy, ...change })

describe('barra inferior de navegación', () => {
  it('tiene exactamente las tres opciones, con su icono y etiqueta', () => {
    expect(NAV_ITEMS.map((item) => [item.key, item.label])).toEqual([['sessions', 'Sesiones'], ['scanner', 'Escanear'], ['sync', 'Sincronizar']])
    const html = renderToStaticMarkup(<BottomNav viewName="sessions" onSelect={() => undefined} />)
    expect(html.match(/<button/g)).toHaveLength(3)
    expect(html.match(/<svg/g)).toHaveLength(3)
    expect(html.match(/class="nav-icon"/g)).toHaveLength(3)
    for (const label of ['Sesiones', 'Escanear', 'Sincronizar']) expect(html).toContain(`<span class="nav-label">${label}</span>`)
  })

  it('cada opción lleva a su pantalla, solo navegando', () => {
    expect(viewForNav('sessions')).toEqual({ name: 'sessions' })
    expect(viewForNav('scanner', 'sesion-1')).toEqual({ name: 'scanner', sessionId: 'sesion-1' })
    expect(viewForNav('scanner')).toEqual({ name: 'scanner', sessionId: undefined })
    expect(viewForNav('sync')).toEqual({ name: 'sync' })
  })

  it('al pulsar cada opción se notifica solo esa opción', () => {
    const onSelect = vi.fn()
    const nav = BottomNav({ viewName: 'sessions', onSelect }) as ReactElement<{ children: ReactNode }>
    const buttons = (nav.props.children as ReactElement<{ onClick: () => void }>[]).filter(isValidElement)
    expect(buttons).toHaveLength(3)
    buttons.forEach((button) => button.props.onClick())
    expect(onSelect.mock.calls.map((call) => call[0])).toEqual(['sessions', 'scanner', 'sync'])
  })

  it('resalta una sola opción según la pantalla: texto legible, icono destacado y aria-current', () => {
    const cases: Array<[string, NavKey | null]> = [['sessions', 'sessions'], ['inventory', 'sessions'], ['form', 'sessions'], ['detail', 'sessions'], ['scanner', 'scanner'], ['sync', 'sync'], ['backup', null]]
    for (const [viewName, expected] of cases) {
      expect(activeNavKey(viewName)).toBe(expected)
      const html = renderToStaticMarkup(<BottomNav viewName={viewName} onSelect={() => undefined} />)
      expect(html.match(/aria-current="page"/g)?.length ?? 0).toBe(expected ? 1 : 0)
      expect(html.match(/class="active"/g)?.length ?? 0).toBe(expected ? 1 : 0)
      if (expected) expect(html).toMatch(new RegExp(`class="active" aria-current="page"><span class="nav-icon">.*?</span><span class="nav-label">${NAV_ITEMS.find((item) => item.key === expected)!.label}</span>`))
    }
  })

  it('los estilos dan tres columnas, áreas táctiles amplias, áreas seguras y espacio para no tapar el contenido', () => {
    const css = readFileSync('src/styles.css', 'utf8')
    const block = css.slice(css.indexOf('/* Barra inferior: tres opciones equilibradas'))
    expect(block).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))')
    expect(block).toMatch(/\.bottom-nav button \{[^}]*min-height: 58px/)
    expect(Number(/min-height: (\d+)px/.exec(block.slice(block.indexOf('.bottom-nav button {')))?.[1])).toBeGreaterThanOrEqual(44)
    expect(block).toContain('env(safe-area-inset-bottom)')
    expect(block).toContain('env(safe-area-inset-left)')
    expect(block).toMatch(/\.app-shell \{ padding-bottom: calc\(104px \+ env\(safe-area-inset-bottom\)\)/)
    expect(block).toMatch(/\.bottom-nav button\.active \{[^}]*background/)
    expect(block).toMatch(/\.bottom-nav button\.active \.nav-icon \{[^}]*var\(--lime\)/)
    expect(block).toContain('@media (max-width: 360px)')
    expect(block).toContain('@media (min-width: 900px)')
  })

  it('Respaldo sigue accesible desde el encabezado y la barra no se rompe con una cuarta opción', () => {
    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app).toContain('aria-label="Respaldo y exportación"')
    expect(app).toContain("onClick={() => setView({ name: 'backup' })}")
    expect(app).not.toContain('const navItems')
  })
})

describe('alerta contextual de sincronización', () => {
  it('no aparece cuando todo está al día, ni sin sesión', () => {
    expect(computeSyncAlert(input())).toBeNull()
    expect(computeSyncAlert(input({ signedIn: false, pending: 5, failedOperations: 2 }))).toBeNull()
    expect(computeSyncAlert(input({ firebaseReachable: undefined }))).toBeNull() // aún no se ha intentado
  })

  it('con la sincronización detenida a propósito y sin nada pendiente ni problemas, no muestra nada', () => {
    expect(computeSyncAlert(input({ syncHeld: true }))).toBeNull()
    expect(computeSyncAlert(input({ syncHeld: true, online: false }))).toBeNull()
  })

  it('aparece (aviso) cuando la sincronización está detenida y hay cambios pendientes', () => {
    const alert = computeSyncAlert(input({ syncHeld: true, pending: 3 }))
    expect(alert).toMatchObject({ level: 'warning' })
    expect(alert!.reasons).toEqual(['La sincronización está detenida y hay 3 cambios sin enviar'])
    expect(computeSyncAlert(input({ syncHeld: true, pending: 1 }))!.reasons[0]).toContain('1 cambio sin enviar')
  })

  it('aparece (error) con operaciones fallidas, con Firebase no disponible o con una sincronización fallida', () => {
    expect(computeSyncAlert(input({ failedOperations: 2 }))).toMatchObject({ level: 'error', reasons: ['2 operaciones no se pudieron sincronizar'] })
    expect(computeSyncAlert(input({ failedOperations: 1 }))!.reasons[0]).toBe('1 operación no se pudo sincronizar')
    expect(computeSyncAlert(input({ firebaseReachable: false }))).toMatchObject({ level: 'error', reasons: ['No se pudo conectar con Firebase'] })
    expect(computeSyncAlert(input({ lastSyncFailed: true }))).toMatchObject({ level: 'error', reasons: ['La última sincronización falló'] })
  })

  it('sin conexión no se culpa a Firebase: solo informa si hay cambios por enviar', () => {
    expect(computeSyncAlert(input({ online: false, firebaseReachable: false }))).toBeNull()
    expect(computeSyncAlert(input({ online: false, pending: 2 }))).toMatchObject({ level: 'info', reasons: ['Sin conexión: 2 cambios se enviarán al recuperarla'] })
  })

  it('aparece (aviso) con un problema real de fotografías', () => {
    expect(computeSyncAlert(input({ photoProblems: 2 }))).toMatchObject({ level: 'warning', reasons: ['2 fotografías necesitan atención'] })
    expect(computeSyncAlert(input({ photoProblems: 1 }))!.reasons[0]).toBe('1 fotografía necesita atención')
  })

  it('con varios problemas muestra una sola alerta con el nivel más grave y los motivos resumidos', () => {
    const alert = computeSyncAlert(input({ syncHeld: true, pending: 4, failedOperations: 1, photoProblems: 2, firebaseReachable: false }))!
    expect(alert.level).toBe('error')
    expect(alert.reasons).toEqual([
      '1 operación no se pudo sincronizar', 'No se pudo conectar con Firebase', '2 fotografías necesitan atención', 'La sincronización está detenida y hay 4 cambios sin enviar'
    ])
    expect(new Set(alert.reasons).size).toBe(alert.reasons.length)
    expect(alert.title).toBe('Hay un problema con la sincronización')
  })

  it('desaparece cuando se resuelven los problemas', () => {
    const problem = input({ syncHeld: true, pending: 2, failedOperations: 1, firebaseReachable: false, photoProblems: 1 })
    expect(computeSyncAlert(problem)).not.toBeNull()
    expect(computeSyncAlert({ ...problem, failedOperations: 0 })!.level).toBe('error') // sigue Firebase
    expect(computeSyncAlert({ ...problem, failedOperations: 0, firebaseReachable: true })!.level).toBe('warning')
    expect(computeSyncAlert({ ...problem, failedOperations: 0, firebaseReachable: true, photoProblems: 0 })!.reasons).toHaveLength(1)
    expect(computeSyncAlert({ ...problem, failedOperations: 0, firebaseReachable: true, photoProblems: 0, pending: 0 })).toBeNull()
  })

  it('la alerta es compacta y no bloquea: sin posición fija, con botón «Revisar» y un solo elemento', () => {
    const alert = computeSyncAlert(input({ failedOperations: 2 }))!
    const html = renderToStaticMarkup(<SyncAlertBar alert={alert} onReview={() => undefined} />)
    expect(html.match(/class="sync-alert level-error"/g)).toHaveLength(1)
    expect(html).toContain('role="alert"')
    expect(html).toContain('>Revisar</button>')
    expect(html).toContain('2 operaciones no se pudieron sincronizar')
    expect(renderToStaticMarkup(<SyncAlertBar alert={computeSyncAlert(input({ syncHeld: true, pending: 1 }))!} onReview={() => undefined} />)).toContain('role="status"')
    const css = readFileSync('src/styles.css', 'utf8')
    const block = css.slice(css.lastIndexOf('.sync-alert-wrap'))
    expect(block).not.toMatch(/\.sync-alert[^{]*\{[^}]*position: (fixed|absolute)/)
  })

  it('pulsar «Revisar» solo abre la pantalla de sincronización: no ejecuta ninguna operación', () => {
    const onReview = vi.fn()
    const bar = SyncAlertBar({ alert: computeSyncAlert(input({ failedOperations: 1 }))!, onReview }) as ReactElement<{ children: ReactNode }>
    const find = (node: ReactNode): ReactElement<{ className?: string; onClick?: () => void; children?: ReactNode }> | undefined => {
      if (!isValidElement(node)) return Array.isArray(node) ? node.map(find).find(Boolean) : undefined
      const element = node as ReactElement<{ className?: string; onClick?: () => void; children?: ReactNode }>
      return element.props.className === 'sync-alert-action' ? element : find(element.props.children)
    }
    const button = find(bar)!
    expect(button).toBeDefined()
    button.props.onClick!()
    expect(onReview).toHaveBeenCalledTimes(1)
    expect(onReview).toHaveBeenCalledWith()

    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app).toMatch(/<SyncAlertBar alert=\{syncAlert\} onReview=\{\(\) => setView\(\{ name: 'sync' \}\)\} \/>/)
    // Abrir la sección solo compara en lectura (comprobado también en syncNavigation.test.tsx).
    const effect = app.slice(app.indexOf("// Abrir «Sincronizar inventario» solo compara en lectura"))
    expect(effect.slice(0, effect.indexOf('}, [view.name'))).not.toMatch(/executeProposal|synchronize\(|pullCloudData\(|enqueueOwnUploads/)
  })

  it('se muestra una sola vez, solo en las pantallas de consulta, y nunca en formularios ni en el escáner', () => {
    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app.match(/<SyncAlertBar /g)).toHaveLength(1)
    expect(app).toContain("syncAlert && (view.name === 'sessions' || view.name === 'inventory')")
  })

  it('el mensaje permanente de sincronización detenida ya no existe', () => {
    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app).not.toContain('puedes registrar, editar y consultar equipos con normalidad')
    expect(app).not.toContain('Abrir «Sincronizar inventario»</button>')
  })

  it('la alerta se calcula solo con datos ya cargados: no activa sincronización ni escribe', () => {
    const app = readFileSync('src/App.tsx', 'utf8')
    const start = app.indexOf('const syncAlert = computeSyncAlert(')
    const body = app.slice(start, app.indexOf('const openDetail', start))
    expect(body).toContain('syncHeld: !syncAllowed(recovery)')
    for (const forbidden of ['runSync', 'synchronize', 'recoveryHoldRef', 'setRecovery', 'setView', 'saveComputer']) expect(body).not.toContain(forbidden)
    expect([...app.matchAll(/recoveryHoldRef\.current = false/g)]).toHaveLength(1)
  })
})
