import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { AuthSyncPanel } from './components/AuthSyncPanel'
import { ComputerForm } from './components/ComputerForm'
import { PhotoPreview } from './components/PhotoPreview'
import { DatabaseBackupIcon, LayoutGridIcon, ScanLineIcon } from './components/NavIcons'
import { createExampleData } from './sampleData'
import {
  deleteComputer,
  deleteSessionAndComputers,
  claimLocalData,
  getLocalImportPreview,
  listVisibleComputers,
  listVisibleSessions,
  saveSession
} from './db'
import { describeSyncError, migrateLegacyCloudData, pendingCount, pullCloudData, subscribeToSharedInventory, synchronize, synchronizeAndPull, verifyCloudOwnership, type SyncSummary } from './cloudSync'
import { describeFirebaseAuthError, firebaseAuth, firebaseConfigured, prepareFirebaseAuth, signInWithGoogle } from './firebaseClient'
import { imageKitConfigured } from './imageKitClient'
import type { ComputerRecord, InventorySession, SyncStatus } from './types'
import { displayEquipmentType, driveSummary, emptyComputer, formatDateTime, uid } from './utils'

const BackupView = lazy(() => import('./components/BackupView').then((module) => ({ default: module.BackupView })))
const ScannerView = lazy(() => import('./components/ScannerView').then((module) => ({ default: module.ScannerView })))

const PAGE_SIZE = 50

const creatorFields = (user: User) => ({ ownerId: user.uid, ownerName: user.displayName || '', ownerEmail: user.email || '' })

type View =
  | { name: 'sessions' }
  | { name: 'inventory'; sessionId: string }
  | { name: 'scanner'; sessionId?: string }
  | { name: 'form'; computer: ComputerRecord }
  | { name: 'detail'; computerId: string }
  | { name: 'backup' }

export default function App() {
  const [sessions, setSessions] = useState<InventorySession[]>([])
  const [computers, setComputers] = useState<ComputerRecord[]>([])
  const [view, setView] = useState<View>({ name: 'sessions' })
  const [loading, setLoading] = useState(true)
  const [authReady, setAuthReady] = useState(!firebaseAuth)
  const [toast, setToast] = useState('')
  const [authError, setAuthError] = useState('')
  const [user, setUser] = useState<User | null>(null)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('local')
  const [syncMessage, setSyncMessage] = useState('Guardado local')
  const [pending, setPending] = useState(0)
  const [isSyncing, setIsSyncing] = useState(false)
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<string | null>(null)
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null)
  const [importPreview, setImportPreview] = useState<{ sessions: number; computers: number; photos: number } | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const activeSyncRef = useRef<Promise<SyncSummary | undefined> | null>(null)

  const refresh = useCallback(async (ownerId: string | null) => {
    const [nextSessions, nextComputers, nextPending] = await Promise.all([
      listVisibleSessions(ownerId),
      listVisibleComputers(ownerId),
      pendingCount(ownerId)
    ])
    setSessions(nextSessions)
    setComputers(nextComputers)
    setPending(nextPending)
    setLoading(false)
  }, [])

  const reportSync = useCallback((status: SyncStatus, message: string) => {
    setSyncStatus(status)
    setSyncMessage(message)
  }, [])

  const applySyncResult = useCallback((result: SyncSummary) => {
    setNextRetryAt(result.pending > 0 && result.retryAfterMs !== undefined ? Date.now() + Math.max(500, result.retryAfterMs) : null)
    if (result.errors && result.lastError) setToast(`Sincronización pendiente: ${result.lastError}`)
  }, [])

  const recordSuccessfulUpdate = useCallback((ownerId: string) => {
    const value = new Date().toISOString()
    setLastSuccessfulAt(value)
    try { localStorage.setItem(`inventario.lastSuccessfulSync.${ownerId}`, value) } catch { /* almacenamiento bloqueado */ }
  }, [])

  const runSync = useCallback((activeUser: User | null = user, force = false) => {
    if (!activeUser) {
      reportSync('local', 'Guardado local')
      return Promise.resolve(undefined)
    }
    if (activeSyncRef.current) return activeSyncRef.current
    const task = (async (): Promise<SyncSummary | undefined> => {
      if (!navigator.onLine) {
        reportSync('local', 'Sin conexión · guardado local')
        await refresh(activeUser.uid)
        return undefined
      }
      setIsSyncing(true)
      reportSync('syncing', 'Sincronizando…')
      try {
        const result = await synchronizeAndPull(activeUser.uid, reportSync, { force })
        applySyncResult(result)
        await refresh(activeUser.uid)
        if (result.errors) {
          const message = result.lastError || 'Quedaron operaciones pendientes'
          reportSync('error', `Error al sincronizar · ${message}`)
          setToast(`Sincronización pendiente: ${message}`)
        } else {
          recordSuccessfulUpdate(activeUser.uid)
          reportSync('synced', force ? 'Actualizado ahora' : 'Sincronizado')
        }
        return result
      } catch (error) {
        const message = describeSyncError(error)
        console.error('No fue posible sincronizar el inventario', error)
        reportSync('error', `Error al sincronizar · ${message}`)
        setToast(message)
        const pendingNow = await pendingCount(activeUser.uid)
        await refresh(activeUser.uid)
        return { synced: 0, errors: 1, photosLocalOnly: 0, pending: pendingNow, lastError: message }
      }
    })()
    activeSyncRef.current = task
    void task.finally(() => {
      if (activeSyncRef.current === task) {
        activeSyncRef.current = null
        setIsSyncing(false)
      }
    })
    return task
  }, [applySyncResult, recordSuccessfulUpdate, refresh, reportSync, user])

  const afterLocalChange = useCallback(async () => {
    reportSync('local', 'Guardado local')
    await refresh(user?.uid || null)
    if (user) return runSync(user)
    return undefined
  }, [refresh, reportSync, runSync, user])

  useEffect(() => {
    void navigator.storage?.persist?.()
    const auth = firebaseAuth
    if (!auth) {
      setAuthReady(true)
      void refresh(null)
      return
    }
    let active = true
    let redirectFinished = false
    let initialStateObserved = false
    let initialUser: User | null = null
    let initialApplied = false

    const applyUser = (nextUser: User | null) => {
      if (!active) return
      setUser(nextUser)
      if (nextUser) {
        try { setLastSuccessfulAt(localStorage.getItem(`inventario.lastSuccessfulSync.${nextUser.uid}`)) } catch { setLastSuccessfulAt(null) }
      } else setLastSuccessfulAt(null)
      setAuthReady(true)
      void (async () => {
        if (nextUser) {
          reportSync('syncing', 'Sincronizando')
          try {
            await migrateLegacyCloudData(nextUser)
            const preview = await getLocalImportPreview()
            if (preview.sessions || preview.computers) setImportPreview(preview)
            else {
              const result = await synchronize(nextUser.uid, reportSync)
              applySyncResult(result)
            }
          } catch (error) {
            console.error('No fue posible recuperar o sincronizar el inventario al iniciar', error)
            reportSync('error', 'Error al sincronizar')
            setToast(error instanceof Error ? error.message : 'No fue posible sincronizar')
          }
          await refresh(nextUser.uid)
        } else {
          reportSync('local', 'Guardado local')
          await refresh(null)
        }
      })()
    }

    const applyInitialUser = () => {
      if (!active || initialApplied || !redirectFinished || !initialStateObserved) return
      initialApplied = true
      applyUser(initialUser)
    }

    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      if (!initialApplied) {
        initialStateObserved = true
        initialUser = nextUser
        applyInitialUser()
        return
      }
      applyUser(nextUser)
    })

    void prepareFirebaseAuth()
      .then((redirectUser) => {
        if (redirectUser) initialUser = redirectUser
      })
      .catch((error) => {
        const message = describeFirebaseAuthError(error)
        console.error('Firebase Auth: getRedirectResult falló', error)
        if (active) {
          setAuthError(message)
          setToast(message)
        }
      })
      .finally(() => {
        redirectFinished = true
        applyInitialUser()
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [applySyncResult, refresh, reportSync])

  useEffect(() => {
    const ownerId = user?.uid
    if (!ownerId) return
    return subscribeToSharedInventory(ownerId, {
      onApplied: async (stats) => {
        await refresh(ownerId)
        recordSuccessfulUpdate(ownerId)
        const changes = stats.sessions + stats.computers + stats.removed
        reportSync('synced', changes === 1 ? 'Actualizado en tiempo real' : `Actualizado en tiempo real · ${changes} cambios`)
      },
      onError: (error) => {
        const message = describeSyncError(error)
        console.error('Listener de Firestore detenido', error)
        reportSync('error', `Error de actualización · ${message}`)
        setToast(message)
      }
    })
  }, [recordSuccessfulUpdate, refresh, reportSync, user?.uid])

  useEffect(() => {
    const handleOnline = () => { if (user) void runSync(user) }
    const handleOffline = () => reportSync('local', 'Guardado local')
    const handleResume = () => { if (user && navigator.onLine) void runSync(user) }
    const handleVisibility = () => { if (document.visibilityState === 'visible') handleResume() }
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('focus', handleResume)
    window.addEventListener('pageshow', handleResume)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('focus', handleResume)
      window.removeEventListener('pageshow', handleResume)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [reportSync, runSync, user])

  useEffect(() => {
    if (!user || nextRetryAt === null || !navigator.onLine) return
    const timer = window.setTimeout(() => void runSync(user), Math.max(0, nextRetryAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [nextRetryAt, runSync, user])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  const currentSessionId = view.name === 'inventory' || view.name === 'scanner'
    ? view.sessionId
    : view.name === 'form'
      ? view.computer.sessionId
      : view.name === 'detail'
        ? computers.find((item) => item.id === view.computerId)?.sessionId
        : undefined

  const openDetail = (id: string) => setView({ name: 'detail', computerId: id })

  const navItems = [
    { key: 'sessions', label: 'Sesiones', icon: <LayoutGridIcon />, action: () => setView({ name: 'sessions' }) },
    { key: 'scanner', label: 'Escanear', icon: <ScanLineIcon />, action: () => setView({ name: 'scanner', sessionId: currentSessionId }) },
    { key: 'backup', label: 'Respaldo', icon: <DatabaseBackupIcon />, action: () => setView({ name: 'backup' }) }
  ]

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView({ name: 'sessions' })}>
          <span className="brand-mark"><i /><i /><i /></span>
          <span><strong>Inventario</strong><small>computadoras</small></span>
        </button>
        {!authReady ? <div className="auth-checking">Comprobando sesión…</div> : <AuthSyncPanel
          configured={firebaseConfigured}
          user={user}
          status={syncStatus}
          message={syncMessage}
          pending={pending}
          isSyncing={isSyncing}
          lastSuccessfulAt={lastSuccessfulAt}
          onLogin={() => void startGoogleLogin(setAuthError, setToast)}
          onLogout={() => { if (firebaseAuth) void signOut(firebaseAuth) }}
          onSync={() => void runSync(user, true)}
        />}
      </header>

      {!authReady ? <div className="loading-screen"><div className="spinner" /><p>Comprobando sesión…</p></div> : loading ? <div className="loading-screen"><div className="spinner" /><p>Abriendo inventario compartido…</p></div> : !user ? (
        <SignInGate configured={firebaseConfigured} error={authError} onLogin={() => void startGoogleLogin(setAuthError, setToast)} />
      ) : (
        <>
          {view.name === 'sessions' && <SessionsScreen
            sessions={sessions}
            computers={computers}
            onOpen={(sessionId) => setView({ name: 'inventory', sessionId })}
            user={user}
            onLocalChange={afterLocalChange}
            onToast={setToast}
          />}
          {view.name === 'inventory' && <InventoryScreen
            session={sessions.find((session) => session.id === view.sessionId)}
            computers={computers.filter((computer) => computer.sessionId === view.sessionId)}
            onBack={() => setView({ name: 'sessions' })}
            onScan={() => setView({ name: 'scanner', sessionId: view.sessionId })}
            onAdd={() => setView({ name: 'form', computer: { ...emptyComputer(view.sessionId), ...creatorFields(user), syncStatus: 'local' } })}
            onOpen={openDetail}
          />}
          {view.name === 'scanner' && <Suspense fallback={<LoadingPanel label="Abriendo escáner…" />}><ScannerView
            sessions={sessions}
            initialSessionId={view.sessionId}
            onCancel={() => view.sessionId ? setView({ name: 'inventory', sessionId: view.sessionId }) : setView({ name: 'sessions' })}
            onCreate={(computer) => setView({ name: 'form', computer: { ...computer, ...creatorFields(user), syncStatus: 'local' } })}
            onOpenExisting={openDetail}
            onUpdateExisting={(computer) => {
              if (computer.ownerId === user.uid) setView({ name: 'form', computer })
              else {
                setToast('El registro existe; solo su creador puede actualizarlo')
                openDetail(computer.id)
              }
            }}
          /></Suspense>}
          {view.name === 'form' && <ComputerForm
            initial={view.computer}
            sessionName={sessions.find((session) => session.id === view.computer.sessionId)?.name || 'Sesión'}
            onCancel={() => setView({ name: 'inventory', sessionId: view.computer.sessionId })}
            onOpenExisting={openDetail}
            onSaved={async (saved) => {
              const result = await afterLocalChange()
              setToast(result?.errors ? 'Guardado local; Firebase rechazó la sincronización' : user ? 'Sincronizado' : 'Guardado local')
              setView({ name: 'detail', computerId: saved.id })
            }}
          />}
          {view.name === 'detail' && <DetailScreen
            computer={computers.find((computer) => computer.id === view.computerId)}
            session={sessions.find((session) => session.id === computers.find((computer) => computer.id === view.computerId)?.sessionId)}
            onBack={(sessionId) => setView({ name: 'inventory', sessionId })}
            onEdit={(computer) => setView({ name: 'form', computer })}
            currentUserId={user.uid}
            onDeleted={async (sessionId) => {
              const result = await afterLocalChange()
              setToast(result?.errors ? 'Eliminado localmente; error al sincronizar' : user ? 'Eliminación sincronizada' : 'Eliminación guardada localmente')
              setView({ name: 'inventory', sessionId })
            }}
          />}
          {view.name === 'backup' && <Suspense fallback={<LoadingPanel label="Abriendo herramientas de respaldo…" />}><BackupView sessions={sessions} computers={computers} ownerId={user.uid} onChanged={() => void afterLocalChange()} /></Suspense>}
        </>
      )}

      {user && <nav className="bottom-nav" aria-label="Navegación principal">
        {navItems.map((item) => {
          const active = item.key === view.name || (item.key === 'sessions' && ['inventory', 'form', 'detail'].includes(view.name))
          return <button className={active ? 'active' : ''} key={item.key} onClick={item.action}><span className="nav-icon">{item.icon}</span>{item.label}</button>
        })}
      </nav>}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
      {importPreview && user && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <section className="modal-card import-card">
          <p className="eyebrow">Datos encontrados en este dispositivo</p>
          <h2 id="import-title">Importar a Firebase</h2>
          <p>Revisa lo que se agregará al inventario compartido bajo tu autoría. Los originales locales no se borrarán.</p>
          <div className="import-counts"><div><strong>{importPreview.sessions}</strong><span>sesiones</span></div><div><strong>{importPreview.computers}</strong><span>equipos</span></div><div><strong>{importPreview.photos}</strong><span>fotos locales</span></div></div>
          {!imageKitConfigured && importPreview.photos > 0 && <p className="inline-note warning-box">Las fotografías se conservarán localmente hasta configurar el backend privado de ImageKit.</p>}
          <div className="button-row">
            <button className="secondary-button" disabled={importBusy} onClick={() => setImportPreview(null)}>Ahora no</button>
            <button className="primary-button" disabled={importBusy} onClick={() => void (async () => {
              setImportBusy(true)
              reportSync('syncing', 'Sincronizando')
              await claimLocalData(user.uid, user.displayName || '', user.email || '')
              const result = await synchronize(user.uid, reportSync, { force: true })
              applySyncResult(result)
              const verified = result.errors === 0 && await verifyCloudOwnership(user.uid)
              await pullCloudData(user.uid)
              await refresh(user.uid)
              setImportBusy(false)
              if (verified) {
                setImportPreview(null)
                setToast('Importación verificada; los originales siguen en este dispositivo')
              } else setToast('Firebase no confirmó todos los datos; se conservaron localmente')
            })()}>{importBusy ? 'Sincronizando…' : 'Importar y verificar'}</button>
          </div>
        </section>
      </div>}
    </div>
  )
}

function LoadingPanel({ label }: { label: string }) {
  return <div className="loading-screen"><div className="spinner" /><p>{label}</p></div>
}

function SignInGate({ configured, error, onLogin }: { configured: boolean; error: string; onLogin: () => void }) {
  return <main className="screen auth-gate"><section className="empty-state"><div className="empty-illustration"><span>▦</span><span>G</span></div><p className="eyebrow">Inventario compartido</p><h1>Inicia sesión para continuar</h1><p>Cualquier persona con una cuenta de Google puede consultar el inventario y agregar registros. Las fotografías y ubicaciones son visibles para todas las cuentas que inicien sesión. Solo quien crea un registro puede editarlo o eliminarlo.</p>{error && <p className="warning-box auth-error" role="alert">{error}</p>}<button className="primary-button" disabled={!configured} onClick={onLogin}><span className="google-mark">G</span> Iniciar sesión con Google</button></section></main>
}

async function startGoogleLogin(setAuthError: (message: string) => void, setToast: (message: string) => void) {
  setAuthError('')
  try {
    await signInWithGoogle()
  } catch (error) {
    const message = describeFirebaseAuthError(error)
    console.error('Firebase Auth: inicio de sesión con Google falló', error)
    setAuthError(message)
    setToast(message)
  }
}

interface SessionsProps {
  sessions: InventorySession[]
  computers: ComputerRecord[]
  onOpen: (id: string) => void
  onToast: (message: string) => void
  user: User
  onLocalChange: () => Promise<SyncSummary | undefined>
}

function SessionsScreen({ sessions, computers, onOpen, onToast, user, onLocalChange }: SessionsProps) {
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [location, setLocation] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    const stamp = new Date().toISOString()
    const session: InventorySession = { id: uid(), name: name.trim(), date, location: location.trim(), ...creatorFields(user), syncStatus: 'local', createdAt: stamp, updatedAt: stamp }
    await saveSession(session)
    const result = await onLocalChange()
    setBusy(false)
    setShowForm(false)
    setName('')
    setLocation('')
    onToast(result?.errors ? 'Sesión guardada localmente; error al sincronizar' : 'Sesión sincronizada')
    onOpen(session.id)
  }

  const loadExamples = async () => {
    setBusy(true)
    const session = await createExampleData(user.uid, user.displayName || '', user.email || '')
    const result = await onLocalChange()
    setBusy(false)
    onToast(result?.errors ? 'Ejemplo local; error al sincronizar' : 'Ejemplo sincronizado')
    onOpen(session.id)
  }

  const remove = async (session: InventorySession) => {
    if (session.ownerId !== user.uid) {
      onToast('Solo quien creó la sesión puede eliminarla')
      return
    }
    const sessionComputers = computers.filter((computer) => computer.sessionId === session.id)
    if (sessionComputers.some((computer) => computer.ownerId !== user.uid)) {
      onToast('No se puede eliminar: contiene equipos creados por otras cuentas')
      return
    }
    const count = sessionComputers.length
    if (!window.confirm(`¿Eliminar “${session.name}” y sus ${count} equipo${count === 1 ? '' : 's'}?`)) return
    await deleteSessionAndComputers(session.id, session.ownerId)
    const result = await onLocalChange()
    onToast(result?.errors ? 'Eliminada localmente; error al sincronizar' : 'Eliminación sincronizada')
  }

  return (
    <main className="screen">
      <div className="hero-panel">
        <div>
          <p className="eyebrow">Control en campo</p>
          <h1>Sesiones de inventario</h1>
          <p>Crea una jornada y registra cada equipo, incluso sin conexión.</p>
        </div>
        <button className="primary-button" onClick={() => setShowForm(true)}>+ Nueva sesión</button>
      </div>

      <section className="summary-strip">
        <div><strong>{sessions.length}</strong><span>sesiones</span></div>
        <div><strong>{computers.length}</strong><span>equipos</span></div>
        <div><strong>{computers.filter((computer) => computer.photo || computer.photoRemote).length}</strong><span>con foto</span></div>
      </section>

      {sessions.length ? <div className="session-grid">
        {sessions.map((session) => {
          const count = computers.filter((computer) => computer.sessionId === session.id).length
          return <article className="session-card" key={session.id}>
            <button className="card-main" onClick={() => onOpen(session.id)}>
              <div className="session-symbol">{session.isExample ? 'E' : session.name.slice(0, 1).toLocaleUpperCase('es-MX')}</div>
              <div>
                {session.isExample && <span className="badge">DATOS DE EJEMPLO</span>}
                <SyncBadge status={session.syncStatus} />
                <h2>{session.name}</h2>
                <p>{new Intl.DateTimeFormat('es-MX', { dateStyle: 'long' }).format(new Date(`${session.date}T12:00:00`))}</p>
                <p>{session.location || 'Sin ubicación escrita'}</p>
                <p className="creator-line">Creada por {session.ownerName || session.ownerEmail || 'cuenta autenticada'}</p>
              </div>
              <div className="session-count"><strong>{count}</strong><span>equipos</span></div>
            </button>
            <div className="card-footer">{session.ownerId === user.uid ? <button className="text-button danger" onClick={() => void remove(session)}>Eliminar sesión</button> : <span className="readonly-label">Solo lectura</span>}<button className="text-button" onClick={() => onOpen(session.id)}>Abrir →</button></div>
          </article>
        })}
      </div> : <section className="empty-state">
        <div className="empty-illustration"><span>▭</span><span>⌗</span></div>
        <h2>Tu inventario empieza aquí</h2>
        <p>Crea una sesión real o carga un ejemplo claramente identificado para conocer el flujo.</p>
        <div className="button-row"><button className="primary-button" onClick={() => setShowForm(true)}>Crear primera sesión</button><button className="ghost-button" disabled={busy} onClick={() => void loadExamples()}>Cargar ejemplo</button></div>
      </section>}

      {sessions.length > 0 && !sessions.some((session) => session.isExample) && <button className="example-link" disabled={busy} onClick={() => void loadExamples()}>Cargar datos de ejemplo</button>}

      {showForm && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-session-title">
        <form className="modal-card" onSubmit={save}>
          <p className="eyebrow">Nueva jornada</p>
          <h2 id="new-session-title">Crear sesión</h2>
          <label>Nombre de la sesión
            <input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="Inventario laboratorio 1" />
          </label>
          <label>Fecha
            <input required type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </label>
          <label>Ubicación general
            <input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Edificio A, planta baja" />
          </label>
          <div className="button-row"><button type="button" className="secondary-button" onClick={() => setShowForm(false)}>Cancelar</button><button className="primary-button" disabled={busy || !name.trim()}>{busy ? 'Guardando…' : 'Crear sesión'}</button></div>
        </form>
      </div>}
    </main>
  )
}

interface InventoryProps {
  session?: InventorySession
  computers: ComputerRecord[]
  onBack: () => void
  onScan: () => void
  onAdd: () => void
  onOpen: (id: string) => void
}

function InventoryScreen({ session, computers, onBack, onScan, onAdd, onOpen }: InventoryProps) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  useEffect(() => {
    const timer = window.setTimeout(() => { setDebounced(query); setVisibleCount(PAGE_SIZE) }, 250)
    return () => window.clearTimeout(timer)
  }, [query])
  const filtered = useMemo(() => {
    const term = debounced.trim().toLocaleLowerCase('es-MX')
    if (!term) return computers
    return computers.filter((computer) => [displayEquipmentType(computer), computer.serialNumber, computer.inventoryId, computer.brand, computer.model].join(' ').toLocaleLowerCase('es-MX').includes(term))
  }, [computers, debounced])
  const shown = filtered.slice(0, visibleCount)

  if (!session) return <main className="screen"><p>La sesión ya no existe.</p><button onClick={onBack}>Volver</button></main>
  return (
    <main className="screen">
      <div className="screen-heading inventory-heading">
        <button className="icon-button" onClick={onBack} aria-label="Volver">←</button>
        <div><p className="eyebrow">{session.date} · {session.location || 'Sin ubicación'}</p><h1>{session.name}</h1></div>
        <div className="big-count"><strong>{computers.length}</strong><span>equipos</span></div>
      </div>
      {session.isExample && <div className="example-banner"><strong>Datos de ejemplo</strong><span>Esta sesión es de demostración y puede eliminarse.</span></div>}
      <div className="inventory-toolbar">
        <label className="search-box"><span>⌕</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por tipo, serie, inventario, marca o modelo" /></label>
        <button className="primary-button" onClick={onScan}>⌗ Escanear</button>
        <button className="secondary-button" onClick={onAdd}>+ Manual</button>
      </div>
      {filtered.length ? <div className="computer-list">
        {shown.map((computer) => <button className="computer-card" key={computer.id} onClick={() => onOpen(computer.id)}>
          <PhotoPreview blob={computer.photo} remote={computer.photoRemote} computerId={computer.cloudId || computer.id} thumbnail alt={`Foto de ${computer.inventoryId}`} className="computer-thumb" unavailableOnDevice={!computer.photo && Boolean(computer.photoStoredLocally || computer.photoPath)} />
          <div className="computer-card-body">
            {computer.isExample && <span className="badge">EJEMPLO</span>}
            <SyncBadge status={computer.syncStatus} />
            <strong>{displayEquipmentType(computer) || 'Tipo no indicado'}</strong>
            <span>{computer.brand || 'Marca pendiente'} {computer.model}</span>
            <small>Inventario: {computer.inventoryId || 'pendiente'} · Serie: {computer.serialNumber || 'pendiente'}</small>
            {computer.photoNeedsUpload && <small className="local-photo-label">Foto local · pendiente de subir</small>}
            {computer.photoRemote && !computer.photoNeedsUpload && <small className="local-photo-label">Foto privada sincronizada</small>}
          </div>
          <span className="chevron">›</span>
        </button>)}
        {filtered.length > shown.length && <button className="secondary-button" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>Mostrar más ({filtered.length - shown.length} restantes)</button>}
      </div> : <section className="empty-state compact-empty"><h2>{query ? 'Sin coincidencias' : 'Aún no hay equipos'}</h2><p>{query ? 'Prueba otra búsqueda.' : 'Escanea un código o registra uno manualmente.'}</p>{!query && <button className="primary-button" onClick={onScan}>Escanear primer equipo</button>}</section>}
    </main>
  )
}

interface DetailProps {
  computer?: ComputerRecord
  session?: InventorySession
  onBack: (sessionId: string) => void
  onEdit: (computer: ComputerRecord) => void
  onDeleted: (sessionId: string) => Promise<void>
  currentUserId: string
}

function DetailScreen({ computer, session, onBack, onEdit, onDeleted, currentUserId }: DetailProps) {
  if (!computer) return <main className="screen"><p>El registro ya no existe.</p></main>
  const canModify = computer.ownerId === currentUserId
  const remove = async () => {
    if (!window.confirm(`¿Eliminar el registro “${computer.inventoryId || computer.serialNumber}”?`)) return
    await deleteComputer(computer.id, computer.ownerId)
    await onDeleted(computer.sessionId)
  }
  return (
    <main className="screen narrow-screen">
      <div className="screen-heading">
        <button className="icon-button" onClick={() => onBack(computer.sessionId)} aria-label="Volver">←</button>
        <div><p className="eyebrow">{session?.name}</p><h1>Detalle del equipo</h1></div>
      </div>
      <section className="detail-hero">
        <PhotoPreview blob={computer.photo} remote={computer.photoRemote} computerId={computer.cloudId || computer.id} alt="Fotografía del equipo" className="detail-photo" unavailableOnDevice={!computer.photo && Boolean(computer.photoStoredLocally || computer.photoPath)} />
        <div><span className="badge">{computer.isExample ? 'DATO DE EJEMPLO' : 'REGISTRO'}</span><SyncBadge status={computer.syncStatus} /><h2>{displayEquipmentType(computer) || 'Tipo de equipo no indicado'}</h2><p>{computer.brand || 'Marca no indicada'} {computer.model}</p>{computer.photoNeedsUpload && <p className="local-photo-label">Fotografía local · pendiente de subir</p>}{computer.photoRemote && !computer.photoNeedsUpload && <p className="local-photo-label">Fotografía privada sincronizada</p>}{computer.photoUploadError && <p className="local-photo-label">Error de fotografía: {computer.photoUploadError}</p>}</div>
      </section>
      <section className="detail-section">
        <div className="section-row"><h2>Información</h2>{canModify ? <button className="ghost-button" onClick={() => onEdit(computer)}>Editar</button> : <span className="readonly-label">Solo el creador puede editar</span>}</div>
        <dl className="detail-grid">
          <div><dt>Tipo de equipo</dt><dd>{displayEquipmentType(computer) || 'No indicado'}</dd></div>
          <div><dt>Número de inventario</dt><dd>{computer.inventoryId || 'No indicado'}</dd></div>
          <div><dt>Número de serie</dt><dd>{computer.serialNumber || 'No indicado'}</dd></div>
          <div><dt>Año</dt><dd>{computer.yearUnknown ? 'Desconocido' : computer.manufacturingYear}</dd></div>
          <div><dt>Sistema operativo</dt><dd>{computer.operatingSystem || 'No indicado'}</dd></div>
          <div><dt>RAM</dt><dd>{computer.ramGB === null ? 'No indicada' : `${computer.ramGB} GB`}</dd></div>
          <div className="wide"><dt>Almacenamiento</dt><dd>{driveSummary(computer.drives)}</dd></div>
          <div className="wide"><dt>Escaneado</dt><dd>{formatDateTime(computer.scannedAt)} · {computer.timezone}</dd></div>
          <div className="wide"><dt>Coordenadas y precisión</dt><dd>{computer.latitude === null ? 'No disponibles' : `${computer.latitude.toFixed(6)}, ${computer.longitude?.toFixed(6)} · precisión aproximada ±${Math.round(computer.accuracyMeters || 0)} m`}</dd></div>
          <div className="wide"><dt>Referencia física</dt><dd>{computer.writtenLocation || 'No indicada'}</dd></div>
          <div className="wide"><dt>Contenido original</dt><dd className="code-value">{computer.originalCode || 'No disponible'}</dd></div>
          <div className="wide"><dt>Observaciones</dt><dd>{computer.notes || 'Sin observaciones'}</dd></div>
          <div className="wide"><dt>Creado por</dt><dd>{computer.ownerName || computer.ownerEmail || 'Cuenta autenticada'}</dd></div>
        </dl>
      </section>
      {canModify && <button className="danger-button" onClick={() => void remove()}>Eliminar este registro</button>}
    </main>
  )
}

function SyncBadge({ status = 'local' }: { status?: SyncStatus }) {
  const labels: Record<SyncStatus, string> = {
    local: 'Guardado local',
    syncing: 'Sincronizando',
    synced: 'Sincronizado',
    error: 'Error al sincronizar'
  }
  return <span className={`record-sync status-${status}`}><i />{labels[status]}</span>
}
