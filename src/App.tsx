import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { createAuthCoordinator } from './authFlow'
import { statusAfterSync, syncToast } from './syncMessages'
import { computeSyncDisplay } from './syncDisplay'
import { AuthSyncPanel } from './components/AuthSyncPanel'
import { SyncInventoryView, type SyncResultView } from './components/SyncInventoryView'
import { advance, initialFlow, type FlowAction, type FlowState } from './syncFlow'
import { buildProposal, describeOperationResults, type SyncProposal } from './syncPlan'
import { ComputerForm } from './components/ComputerForm'
import { PhotoPreview } from './components/PhotoPreview'
import { DatabaseBackupIcon } from './components/NavIcons'
import { BottomNav, viewForNav } from './components/BottomNav'
import { SyncAlertBar } from './components/SyncAlertBar'
import { computeSyncAlert } from './syncAlert'
import {
  deleteComputer,
  deleteSessionAndComputers,
  listVisibleComputers,
  listVisibleSessions,
  saveSession
} from './db'
import { downloadRemotePhoto, imageKitConfigured } from './imageKitClient'
import { enqueueOwnUploads, getPendingSyncQueue, removeLocalComputerCopy } from './db'
import { describeSyncError, failedCount, pendingCount, pullCloudData, subscribeToSharedInventory, synchronize, synchronizeAndPull, type SyncSummary } from './cloudSync'
import type { ControlRun } from './components/RecoveryControls'
import { previewControl, type ControlId } from './recoveryPermissions'
import { readLocalRecoverySnapshot, readRemoteRecoverySnapshot, runRecoveryDiagnostic } from './recovery'
import { planLocalCleanup, runLocalCleanup, type CleanupPlan, type CleanupResult } from './localCleanup'
import { afterDiagnostic, appUsable, authorizeRecovery, CHECKING, keepSyncStopped, mergeDiagnostic, syncAllowed, type RecoveryState } from './recoveryState'
import { authLog, describeFirebaseAuthError, firebaseAuth, firebaseConfigured, prepareFirebaseAuth, signInWithGoogle } from './firebaseClient'
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
  | { name: 'sync' }

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
  const [failedOps, setFailedOps] = useState(0)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const [displayNow, setDisplayNow] = useState(Date.now)
  const [verificationInvalidated, setVerificationInvalidated] = useState(false)
  const verificationEpoch = useRef(0)
  const invalidateVerification = useCallback(() => { verificationEpoch.current += 1; setVerificationInvalidated(true); return verificationEpoch.current }, [])
  const [isSyncing, setIsSyncing] = useState(false)
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<string | null>(null)
  const [nextRetryAt, setNextRetryAt] = useState<number | null>(null)
  const [recovery, setRecovery] = useState<RecoveryState>(CHECKING)
  const recoveryHoldRef = useRef(true)
  const [controlBusy, setControlBusy] = useState<ControlId | null>(null)
  const [controlMessage, setControlMessage] = useState('')
  const [flow, setFlow] = useState<FlowState>(initialFlow)
  const flowRef = useRef<FlowState>(flow)
  const [syncResult, setSyncResult] = useState<SyncResultView | null>(null)
  const recoveryGeneration = useRef(0)
  const activeSyncRef = useRef<Promise<SyncSummary | undefined> | null>(null)

  /** Solo lee y muestra el resultado. Nunca sincroniza ni libera el bloqueo: eso solo lo hace `authorizeSync`. */
  const inspectRecovery = useCallback(async (accountId: string) => {
    const generation = ++recoveryGeneration.current
    const verification = invalidateVerification()
    recoveryHoldRef.current = true
    flowRef.current = initialFlow()
    setFlow(flowRef.current)
    setRecovery(CHECKING)
    try {
      const result = await runRecoveryDiagnostic(accountId, undefined, { origin: window.location.origin, userAgent: navigator.userAgent })
      if (generation !== recoveryGeneration.current) return
      setRecovery(afterDiagnostic(result.report, result.local, result.remote, result.needsReview))
      if (verification === verificationEpoch.current) setVerificationInvalidated(false)
      reportSync('local', 'Sincronización detenida')
    } catch (error) {
      if (generation !== recoveryGeneration.current) return
      setRecovery(CHECKING)
      reportSync('error', 'No se pudo leer IndexedDB; sincronización detenida')
      setToast(error instanceof Error ? error.message : 'No se pudo leer IndexedDB')
    }
  }, [invalidateVerification])

  const refresh = useCallback(async (ownerId: string | null) => {
    const [nextSessions, nextComputers, nextPending, nextFailed] = await Promise.all([
      listVisibleSessions(ownerId),
      listVisibleComputers(ownerId),
      pendingCount(ownerId),
      failedCount(ownerId)
    ])
    setSessions(nextSessions)
    setComputers(nextComputers)
    setPending(nextPending)
    setFailedOps(nextFailed)
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
    if (recoveryHoldRef.current) {
      reportSync('local', 'Sincronización detenida')
      // Se informa de que no se intentó nada: así ningún aviso promete una sincronización automática.
      return pendingCount(activeUser.uid).then((pendingNow): SyncSummary => ({ held: true, synced: 0, errors: 0, photosLocalOnly: 0, pending: pendingNow }))
    }
    if (activeSyncRef.current) return activeSyncRef.current
    const task = (async (): Promise<SyncSummary | undefined> => {
      if (!navigator.onLine) {
        reportSync('local', 'Sin conexión · guardado local')
        await refresh(activeUser.uid)
        return undefined
      }
      setIsSyncing(true)
      const verification = invalidateVerification()
      reportSync('syncing', 'Sincronizando…')
      try {
        const result = await synchronizeAndPull(activeUser.uid, reportSync, { force })
        applySyncResult(result)
        await refresh(activeUser.uid)
        if (!result.errors && !result.pending) {
          try {
            const checked = await runRecoveryDiagnostic(activeUser.uid, undefined, { origin: window.location.origin, userAgent: navigator.userAgent })
            setRecovery((previous) => mergeDiagnostic(previous, checked.report, checked.local, checked.remote, checked.needsReview))
            if (verification === verificationEpoch.current) setVerificationInvalidated(false)
          } catch { /* el indicador permanece sin verificar */ }
        }
        const outcome = statusAfterSync(result, force)
        if (result.errors) setToast(`Sincronización pendiente: ${result.lastError || 'Quedaron operaciones pendientes'}`)
        else if (outcome.status === 'synced') recordSuccessfulUpdate(activeUser.uid)
        reportSync(outcome.status, outcome.message)
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
  }, [applySyncResult, invalidateVerification, recordSuccessfulUpdate, refresh, reportSync, user])

  /** Espera una sincronización en curso (que pudo leer la cola antes de la restauración) y ejecuta una completa. */
  const syncAfterRestore = useCallback(async () => {
    if (activeSyncRef.current) await activeSyncRef.current.catch(() => undefined)
    return runSync(user, true)
  }, [runSync, user])

  /** Autorización explícita (botón en la pantalla de recuperación): libera el bloqueo y, solo entonces, inicia la sincronización. */
  const authorizeSync = useCallback(() => {
    if (!user) return
    const next = authorizeRecovery(recovery, user.uid)
    if (!syncAllowed(next)) return
    recoveryHoldRef.current = false
    setRecovery(next)
    void runSync(user)
  }, [recovery, runSync, user])

  /**
   * Acciones separadas de la pantalla de recuperación. Cada una se ejecuta solo tras su vista previa y confirmación, y NINGUNA
   * libera el bloqueo general: la sincronización normal sigue detenida. Nunca tocan registros ni operaciones de otras cuentas.
   */
  const runControl = useCallback(async ({ control, excludeIds, previewKey }: ControlRun) => {
    if (!user || controlBusy) return
    if (recovery.phase !== 'review' && recovery.phase !== 'ready') return
    if (control === 'keep-stopped') {
      setControlMessage('')
      setRecovery(keepSyncStopped(recovery))
      return
    }
    setControlBusy(control)
    setControlMessage('Ejecutando…')
    const quiet = () => undefined
    try {
      // Se vuelve a leer todo (solo lectura) y se compara con la vista previa confirmada: si algo cambió, no se ejecuta nada.
      const fresh = await runRecoveryDiagnostic(user.uid, undefined, { origin: window.location.origin, userAgent: navigator.userAgent })
      if (previewControl(control, fresh.local, fresh.remote, fresh.report, { imageKitConfigured }).key !== previewKey) {
        setRecovery(afterDiagnostic(fresh.report, fresh.local, fresh.remote, fresh.needsReview))
        setControlMessage('Los datos cambiaron desde la vista previa: no se ejecutó nada. Revisa la vista previa actualizada y confirma de nuevo.')
        return
      }
      const parts: string[] = []
      if (control === 'local-files' || control === 'all') {
        const pulled = await pullCloudData(user.uid, { exclude: excludeIds, keepLocalRecords: true })
        parts.push(`descargados ${pulled.computers} equipos y ${pulled.sessions} sesiones`)
      }
      if (control === 'all') {
        const result = await synchronize(user.uid, quiet, { force: true, scope: 'operations', exclude: excludeIds })
        parts.push(`operaciones subidas ${result.synced}, con error ${result.errors}, pendientes ${result.pending}`)
      }
      if (control === 'photos' || control === 'all') {
        if (!imageKitConfigured) parts.push('fotografías: ImageKit no está configurado')
        else {
          const result = await synchronize(user.uid, quiet, { force: true, scope: 'photos', exclude: excludeIds })
          parts.push(`fotografías procesadas ${result.synced}, con error ${result.errors}, pendientes ${result.pending}`)
        }
      }
      setControlMessage(`Terminado: ${parts.join(' · ')}. La sincronización general sigue detenida; revisa el diagnóstico actualizado.`)
    } catch (error) {
      setControlMessage(`No se completó: ${describeSyncError(error)}`)
    } finally {
      setControlBusy(null)
      reportSync('local', 'Sincronización detenida')
      await inspectRecovery(user.uid)
      await refresh(user.uid)
    }
  }, [controlBusy, inspectRecovery, recovery, refresh, reportSync, user])

  /** Comparación de solo lectura para el flujo «Sincronizar inventario»: no cambia el bloqueo ni escribe nada. */
  const compareNow = useCallback(async () => {
    if (!user) return
    const generation = ++recoveryGeneration.current
    const verification = invalidateVerification()
    try {
      const result = await runRecoveryDiagnostic(user.uid, undefined, { origin: window.location.origin, userAgent: navigator.userAgent })
      if (generation !== recoveryGeneration.current) return
      setRecovery((previous) => mergeDiagnostic(previous, result.report, result.local, result.remote, result.needsReview))
      if (verification === verificationEpoch.current) setVerificationInvalidated(false)
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'No se pudo comparar con Firebase')
    }
  }, [invalidateVerification, user])

  /**
   * Ejecuta una propuesta ya confirmada. Antes de escribir vuelve a leer todo y compara con la propuesta confirmada: si algo
   * cambió, no se ejecuta nada. Cada paso es independiente (los errores parciales no pierden nada: la cola se conserva y se puede reintentar).
   */
  const executeProposal = useCallback(async (proposal: SyncProposal) => {
    if (!user) return
    const verification = invalidateVerification()
    const quiet = () => undefined
    const result: SyncResultView = { updated: [], kept: [], pending: [], errors: [] }
    try {
      const fresh = await runRecoveryDiagnostic(user.uid, undefined, { origin: window.location.origin, userAgent: navigator.userAgent })
      const current = buildProposal(fresh.local, fresh.remote, fresh.report, flowRef.current.decisions, { imageKitConfigured })
      if (current.key !== proposal.key) {
        setRecovery((previous) => mergeDiagnostic(previous, fresh.report, fresh.local, fresh.remote, fresh.needsReview))
        result.errors.push('Los datos cambiaron desde la vista previa: no se ejecutó nada. Revisa la propuesta actualizada y confirma de nuevo.')
        setSyncResult(result)
        return
      }
      if (proposal.enqueueIds.length) {
        try { result.updated.push(`${await enqueueOwnUploads(user.uid, proposal.enqueueIds)} subida(s) preparada(s) en la cola local`) } catch (error) { result.errors.push(`No se pudo preparar la subida: ${describeSyncError(error)}`) }
      }
      if (proposal.runDownload) {
        try {
          const pulled = await pullCloudData(user.uid, { exclude: proposal.excludeIds, keepLocalRecords: true })
          result.updated.push(`Descargado de Firebase: ${pulled.computers} equipos y ${pulled.sessions} sesiones revisados (no se eliminó ningún registro local)`)
        } catch (error) { result.errors.push(`Descarga incompleta: ${describeSyncError(error)}`) }
      }
      if (proposal.runUpload) {
        try {
          const uploaded = await synchronize(user.uid, quiet, { force: true, scope: 'operations', exclude: proposal.excludeIds })
          result.updated.push(`Operaciones subidas: ${uploaded.synced}`)
          if (uploaded.errors) result.errors.push(uploaded.lastError || 'Algunas operaciones fallaron y siguen en la cola')
        } catch (error) { result.errors.push(`Subida incompleta: ${describeSyncError(error)}`) }
      }
      if (proposal.runPhotos) {
        try {
          const uploaded = await synchronize(user.uid, quiet, { force: true, scope: 'photos', exclude: proposal.excludeIds })
          result.updated.push(`Fotografías procesadas: ${uploaded.synced}`)
          if (uploaded.errors) result.errors.push(uploaded.lastError || 'Algunas fotografías fallaron y siguen pendientes')
        } catch (error) { result.errors.push(`Fotografías incompletas: ${describeSyncError(error)}`) }
      }
      if (proposal.runUpload || proposal.runPhotos) {
        // Resultado de cada operación: lo que salió de la cola y lo que sigue pendiente (con su error).
        const attempted = [...(proposal.runUpload ? proposal.steps.upload : []), ...(proposal.runPhotos ? proposal.steps.photos.filter((item) => item.action === 'upload-photo') : [])]
        const outcome = describeOperationResults(attempted, await getPendingSyncQueue(), user.uid)
        result.updated.push(...outcome.done)
        result.pending.push(...outcome.pending)
      }
      result.kept.push(...proposal.kept.filter((item) => item.id !== '*').slice(0, 30).map((item) => `${item.kind === 'session' ? 'sesión' : 'equipo'} ${item.id.slice(0, 22)}: ${item.detail}`))
      if (proposal.kept.some((item) => item.id === '*')) result.kept.push(...proposal.kept.filter((item) => item.id === '*').map((item) => item.detail || ''))
    } catch (error) {
      result.errors.push(`No se completó: ${describeSyncError(error)}`)
    } finally {
      reportSync('local', 'Sincronización detenida')
      try {
        const after = await runRecoveryDiagnostic(user.uid, undefined, { origin: window.location.origin, userAgent: navigator.userAgent })
        setRecovery((previous) => mergeDiagnostic(previous, after.report, after.local, after.remote, after.needsReview))
        if (verification === verificationEpoch.current) setVerificationInvalidated(false)
        result.pending.push(`${after.local.queue.length} operación(es) en la cola local`)
        const photosLeft = after.local.computers.filter((computer) => computer.photo && !computer.photoRemote).length
        if (photosLeft) result.pending.push(`${photosLeft} fotografía(s) con copia local sin subir`)
      } catch { result.pending.push('No se pudo releer el estado después de sincronizar') }
      setSyncResult(result)
      await refresh(user.uid)
    }
  }, [invalidateVerification, refresh, reportSync, user])

  // Abrir «Sincronizar inventario» solo compara en lectura; no sincroniza ni cambia el bloqueo.
  useEffect(() => {
    if (view.name === 'sync' && user && (flowRef.current.step === 'overview' || flowRef.current.step === 'result')) void compareNow()
  }, [view.name, user?.uid, compareNow])

  /** Limpieza de copias locales verificadas: solo lectura hasta la segunda confirmación; nunca escribe en Firebase ni ImageKit. */
  const cleanupDeps = (accountId: string) => ({
    currentUserId: () => firebaseAuth?.currentUser?.uid,
    readLocal: readLocalRecoverySnapshot,
    readRemote: readRemoteRecoverySnapshot,
    loadRemote: online && imageKitConfigured ? downloadRemotePhoto : undefined,
    removeCopy: (item: { id: string; expect?: Parameters<typeof removeLocalComputerCopy>[1] }) => removeLocalComputerCopy(item.id, item.expect!, () => firebaseAuth?.currentUser?.uid),
    log: (result: CleanupResult) => {
      try {
        const key = 'inventario.localCleanupLog'
        const previous = JSON.parse(localStorage.getItem(key) || '[]') as CleanupResult[]
        localStorage.setItem(key, JSON.stringify([...previous.slice(-19), { ...result, accountId }]))
      } catch { /* el registro es opcional */ }
    }
  })
  const previewLocalCleanup = async (): Promise<CleanupPlan> => {
    if (!user) throw new Error('Inicia sesión para revisar las copias locales.')
    const accountId = user.uid
    let remote = null
    try { remote = await readRemoteRecoverySnapshot() } catch { /* se informa como lectura fallida */ }
    return planLocalCleanup({ local: await readLocalRecoverySnapshot(), remote, accountId, authUid: firebaseAuth?.currentUser?.uid, loadRemote: online && imageKitConfigured ? downloadRemotePhoto : undefined })
  }
  const runCleanup = async (plan: CleanupPlan): Promise<CleanupResult> => {
    const result = await runLocalCleanup(plan, true, cleanupDeps(plan.accountId))
    if (user) { await refresh(user.uid); void inspectRecovery(user.uid) }
    return result
  }

  /** El botón del perfil abre la comparación de solo lectura; no ejecuta ninguna sincronización. */
  const openSyncReview = () => {
    dispatchFlow({ type: 'sync-now' })
    setView({ name: 'sync' })
  }

  /** Aplica una acción del flujo. Solo `confirm` desde el paso de confirmación puede ejecutar escrituras. */
  const dispatchFlow = (action: FlowAction, proposal?: SyncProposal) => {
    const { state, effect } = advance(flowRef.current, action)
    flowRef.current = state
    setFlow(state)
    if (effect === 'compare') void compareNow().finally(() => dispatchFlow({ type: 'compared' }))
    if (effect === 'run' && proposal) void executeProposal(proposal).finally(() => dispatchFlow({ type: 'finished' }))
  }

  const afterLocalChange = useCallback(async () => {
    invalidateVerification()
    reportSync('local', 'Guardado local')
    await refresh(user?.uid || null)
    if (!user) return undefined
    // Si ya hay una sincronización en curso pudo leer la cola antes de este cambio: se espera y se ejecuta otra.
    if (activeSyncRef.current) await activeSyncRef.current.catch(() => undefined)
    return runSync(user)
  }, [invalidateVerification, refresh, reportSync, runSync, user])

  useEffect(() => {
    void navigator.storage?.persist?.()
    const auth = firebaseAuth
    if (!auth) {
      setAuthReady(true)
      void refresh(null)
      return
    }
    let active = true
    const applyUser = (nextUser: User | null) => {
      if (!active) return
      authLog('react:apply-user', { user: Boolean(nextUser) })
      setUser(nextUser)
      if (nextUser) {
        try { setLastSuccessfulAt(localStorage.getItem(`inventario.lastSuccessfulSync.${nextUser.uid}`)) } catch { setLastSuccessfulAt(null) }
      } else setLastSuccessfulAt(null)
      setAuthReady(true)
      void (async () => {
        if (nextUser) {
          // El inventario se abre primero; la comparación de solo lectura corre después y nunca bloquea la pantalla principal.
          await refresh(nextUser.uid)
          void inspectRecovery(nextUser.uid)
        } else {
          recoveryGeneration.current += 1
          recoveryHoldRef.current = true
          setRecovery(CHECKING)
          reportSync('local', 'Guardado local')
          await refresh(null)
        }
      })()
    }

    const coordinator = createAuthCoordinator((nextUser) => applyUser(nextUser))
    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      authLog('onAuthStateChanged', { user: Boolean(nextUser), ready: coordinator.ready })
      coordinator.observe(nextUser)
    })

    void prepareFirebaseAuth()
      .then((redirectUser) => coordinator.redirectFinished(redirectUser))
      .catch((error) => {
        const message = describeFirebaseAuthError(error)
        console.error('Firebase Auth: getRedirectResult falló', error)
        if (active) {
          setAuthError(message)
          setToast(message)
        }
      })

    return () => {
      active = false
      unsubscribe()
    }
  }, [inspectRecovery, refresh, reportSync])

  useEffect(() => {
    const ownerId = user?.uid
    if (!ownerId || !syncAllowed(recovery)) return
    return subscribeToSharedInventory(ownerId, {
      onApplied: async (stats) => {
        invalidateVerification()
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
  }, [invalidateVerification, recordSuccessfulUpdate, refresh, reportSync, user?.uid, recovery.phase])

  useEffect(() => {
    const handleOnline = () => { setOnline(true); if (user) void runSync(user) }
    const handleOffline = () => { setOnline(false); reportSync('local', 'Guardado local') }
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

  useEffect(() => {
    const timer = window.setInterval(() => setDisplayNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const currentSessionId = view.name === 'inventory' || view.name === 'scanner'
    ? view.sessionId
    : view.name === 'form'
      ? view.computer.sessionId
      : view.name === 'detail'
        ? computers.find((item) => item.id === view.computerId)?.sessionId
        : undefined

  const syncDisplay = computeSyncDisplay({
    online,
    paused: !syncAllowed(recovery),
    pending,
    failedOperations: failedOps,
    photoProblems: computers.filter((computer) => computer.ownerId === user?.uid && computer.photoUploadStatus === 'error' && Boolean(computer.photo) && !computer.photoRemote).length,
    syncStatus,
    report: recovery.report?.accountId === user?.uid ? recovery.report : undefined,
    invalidated: verificationInvalidated,
    now: displayNow
  })

  // Alerta contextual única: solo aparece con algo que requiere atención; nunca bloquea el registro de equipos.
  const syncAlert = computeSyncAlert({
    signedIn: Boolean(user),
    syncHeld: !syncAllowed(recovery),
    online,
    firebaseReachable: recovery.report?.remoteAvailable,
    pending,
    failedOperations: failedOps,
    photoProblems: computers.filter((computer) => computer.ownerId === user?.uid && computer.photoUploadStatus === 'error' && Boolean(computer.photo) && !computer.photoRemote).length,
    lastSyncFailed: syncStatus === 'error'
  })

  const openDetail = (id: string) => setView({ name: 'detail', computerId: id })


  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView({ name: 'sessions' })}>
          <span className="brand-mark"><i /><i /><i /></span>
          <span><strong>Inventario</strong><small>computadoras</small></span>
        </button>
        {user && <button className={`icon-button backup-link${view.name === 'backup' ? ' active' : ''}`} aria-label="Respaldo y exportación" title="Respaldo y exportación" aria-current={view.name === 'backup' ? 'page' : undefined} onClick={() => setView({ name: 'backup' })}><DatabaseBackupIcon /></button>}
        {!authReady ? <div className="auth-checking">Comprobando sesión…</div> : <AuthSyncPanel
          configured={firebaseConfigured}
          user={user}
          status={syncStatus}
          message={syncMessage}
          display={syncDisplay}
          pending={pending}
          isSyncing={isSyncing}
          lastSuccessfulAt={lastSuccessfulAt}
          onLogin={() => void startGoogleLogin(setAuthError, setToast)}
          onLogout={() => { if (firebaseAuth) void signOut(firebaseAuth) }}
          onSync={openSyncReview}
        />}
      </header>

      {user && syncAlert && (view.name === 'sessions' || view.name === 'inventory') && <SyncAlertBar alert={syncAlert} onReview={() => setView({ name: 'sync' })} />}

      {!authReady ? <div className="loading-screen"><div className="spinner" /><p>Comprobando sesión…</p></div> : loading ? <div className="loading-screen"><div className="spinner" /><p>Abriendo inventario compartido…</p></div> : !user ? (
        <SignInGate configured={firebaseConfigured} error={authError} onLogin={() => void startGoogleLogin(setAuthError, setToast)} />
      ) : (
        <>
          {view.name === 'sync' && (recovery.report && recovery.local
            ? <SyncInventoryView report={recovery.report} local={recovery.local} remote={recovery.remote || null} online={online} display={syncDisplay} imageKitConfigured={imageKitConfigured} loadRemotePhoto={online && imageKitConfigured ? downloadRemotePhoto : undefined} onCleanupPreview={previewLocalCleanup} onCleanupRun={runCleanup} flow={flow} onFlow={dispatchFlow} result={syncResult} message={controlMessage} onBack={() => setView({ name: 'sessions' })} onAuthorize={authorizeSync} onRetry={() => void inspectRecovery(user.uid)} busyControl={controlBusy} controlMessage={controlMessage} onRunControl={(run) => void runControl(run)} />
            : <main className="screen sync-screen"><h1>Sincronizar inventario</h1><p>{recovery.phase === 'checking' ? 'Comparando con Firebase en solo lectura…' : 'No se pudo leer el estado.'}</p><button className="secondary-button" onClick={() => void inspectRecovery(user.uid)}>Reintentar comparación</button><button className="primary-button" onClick={() => setView({ name: 'sessions' })}>Volver al inventario</button></main>)}
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
              setToast(syncToast(result, { synced: 'Sincronizado', local: 'Guardado local', failed: 'Guardado local; Firebase rechazó la sincronización' }))
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
              setToast(syncToast(result, { synced: 'Eliminación sincronizada', local: 'Eliminado localmente', failed: 'Eliminado localmente; error al sincronizar' }))
              setView({ name: 'inventory', sessionId })
            }}
          />}
          {view.name === 'backup' && <Suspense fallback={<LoadingPanel label="Abriendo herramientas de respaldo…" />}><BackupView sessions={sessions} computers={computers} ownerId={user.uid} ownerName={user.displayName || ''} ownerEmail={user.email || ''} onChanged={() => void refresh(user.uid)} onSyncRestore={syncAfterRestore} syncHeld={recovery.phase === 'local-only'} /></Suspense>}
        </>
      )}

      {user && appUsable(recovery) && <BottomNav viewName={view.name} onSelect={(key) => setView(viewForNav(key, currentSessionId))} />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
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
    onToast(syncToast(result, { synced: 'Sesión sincronizada', local: 'Sesión guardada localmente', failed: 'Sesión guardada localmente; error al sincronizar' }))
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
    onToast(syncToast(result, { synced: 'Eliminación sincronizada', local: 'Eliminada localmente', failed: 'Eliminada localmente; error al sincronizar' }))
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
        <p>Crea tu primera sesión para empezar a registrar equipos.</p>
        <div className="button-row"><button className="primary-button" onClick={() => setShowForm(true)}>Crear primera sesión</button></div>
      </section>}

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
