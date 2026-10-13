import { collection, getDocsFromServer } from 'firebase/firestore'
import { getDatabase } from './db'
import { firestore } from './firebaseClient'
import type { ComputerRecord, InventorySession, SyncQueueItem } from './types'
import { normalizeKey, photoToDataUrl } from './utils'

export interface RecoverySnapshot {
  sessions: InventorySession[]
  computers: ComputerRecord[]
  queue: SyncQueueItem[]
}

export interface RemoteRecoverySnapshot {
  sessions: InventorySession[]
  computers: ComputerRecord[]
}

/**
 * Propiedad (informe de solo lectura):
 * - own-record: el propietario coincide en local y remoto y es la cuenta autenticada.
 * - other-account-record: coincide en local y remoto pero es de otra cuenta. Es informativo: es de solo lectura para esta cuenta.
 * - owner-mismatch: local y remoto tienen propietarios distintos. Conflicto real.
 * - owner-missing: falta el propietario (local o remoto). Nunca se reclama ni se reasigna.
 * - foreign-pending-operation: hay una operación pendiente que esta cuenta no puede ejecutar (de otra cuenta, sin propietario o sobre un registro ajeno).
 */
export type RecoveryClassification = 'exact-id' | 'probable-duplicate' | 'local-only' | 'remote-only' | 'remote-unavailable' | 'different'
  | 'own-record' | 'other-account-record' | 'owner-mismatch' | 'owner-missing' | 'foreign-pending-operation'
  | 'photo-pending' | 'queue-pending' | 'manual-review'

export const RECOVERY_CLASSIFICATIONS: RecoveryClassification[] = ['exact-id', 'probable-duplicate', 'local-only', 'remote-only', 'remote-unavailable', 'different',
  'own-record', 'other-account-record', 'owner-mismatch', 'owner-missing', 'foreign-pending-operation', 'photo-pending', 'queue-pending', 'manual-review']

export interface RecoveryRow {
  kind: 'session' | 'computer'
  localId?: string
  remoteId?: string
  sessionId?: string
  ownerId?: string
  remoteOwnerId?: string
  importedFromId?: string
  categories: RecoveryClassification[]
  differences: string[]
  photo: { local: boolean; remoteFileId?: string; needsUpload: boolean; remoteReferenceMissing: boolean }
  pending: Array<{ id: string; operation: SyncQueueItem['operation']; revision?: string; lastError?: string; ownerId?: string; foreign: boolean }>
  proposal: 'keep' | 'no-action' | 'create-after-review' | 'manual-review'
  localRevision?: string
  remoteRevision?: string
}

export interface RecoveryReport {
  generatedAt: string
  accountId: string
  browser?: { origin: string; userAgent: string }
  remoteAvailable: boolean
  rows: RecoveryRow[]
  counts: Record<RecoveryClassification, number>
  /** Resumen de propiedad por fila (sesiones y equipos). */
  ownership: { own: number; otherAccount: number; mismatch: number; missing: number; foreignPending: number; pendingOperations: number }
  localCounts: { sessions: number; computers: number; queue: number }
  remoteCounts?: { sessions: number; computers: number }
  /** Análisis solamente. No habilita escrituras. */
  writesEnabled: false
}

const ignored = new Set([
  'photo', 'syncStatus', 'syncError', 'sharedCloud', 'photoNeedsUpload', 'photoUploadStatus',
  'photoUploadError', 'photoPendingActorId', 'photoLocalRevision', 'photoStoredLocally', 'photoPath', 'ownerName',
  'ownerEmail', 'updatedAt', 'createdAt', 'id', 'cloudId'
])

const stable = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item) && !(item instanceof Blob)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
    : item) ?? 'undefined'

const differences = (local: object, remote: object) => {
  const a = local as Record<string, unknown>
  const b = remote as Record<string, unknown>
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => !ignored.has(key) && stable(a[key] ?? null) !== stable(b[key] ?? null))
    .sort()
}

const pendingFor = (queue: SyncQueueItem[], kind: 'session' | 'computer', accountId: string, localId?: string, remoteId?: string) =>
  queue.filter((item) => (kind === 'session' ? item.operation.includes('session') : item.operation.includes('computer') || item.operation === 'cleanup-photo')
    && Boolean([item.entityId, item.remoteId].some((id) => id && (id === localId || id === remoteId))))
    // Una operación solo es ejecutable por esta cuenta si es suya; el resto se señala sin tocarla.
    .map(({ id, operation, revision, lastError, ownerId }) => ({ id, operation, revision, lastError, ownerId, foreign: ownerId !== accountId }))

type OwnerClass = 'own-record' | 'other-account-record' | 'owner-mismatch' | 'owner-missing'
/** Clasifica la propiedad sin reclamar ni reasignar nada. */
export function classifyOwner(localOwner: string | undefined, remoteOwner: string | undefined, hasLocal: boolean, hasRemote: boolean, accountId: string): OwnerClass {
  if (hasLocal && hasRemote) {
    if (!localOwner || !remoteOwner) return 'owner-missing'
    if (localOwner !== remoteOwner) return 'owner-mismatch'
    return localOwner === accountId ? 'own-record' : 'other-account-record'
  }
  const owner = hasLocal ? localOwner : remoteOwner
  if (!owner) return 'owner-missing'
  return owner === accountId ? 'own-record' : 'other-account-record'
}

const sameKey = (a: ComputerRecord, b: ComputerRecord) => {
  const serialA = normalizeKey(a.serialNumber || '')
  const serialB = normalizeKey(b.serialNumber || '')
  const inventoryA = normalizeKey(a.inventoryId || '')
  const inventoryB = normalizeKey(b.inventoryId || '')
  return Boolean(serialA && serialA === serialB || inventoryA && inventoryA === inventoryB)
}

/**
 * Una referencia remota solo cuenta si Firestore trae un archivo completo y su ruta pertenece al propietario del documento
 * (la misma regla con la que el Worker firma fotografías). Que el documento haya cambiado no basta.
 */
export function hasValidRemotePhoto(record: ComputerRecord | InventorySession | undefined): boolean {
  const ref = (record as ComputerRecord | undefined)?.photoRemote
  const owner = record?.ownerId
  if (!ref || !owner || !/^[A-Za-z0-9_-]+$/.test(owner)) return false
  const prefix = `/inventario/${owner}/`
  const name = typeof ref.filePath === 'string' ? ref.filePath.slice(prefix.length) : ''
  return typeof ref.fileId === 'string' && ref.fileId.length > 0 && typeof ref.url === 'string' && ref.url.length > 0
    && ref.filePath.startsWith(prefix) && /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('.')
}

export function buildRecoveryReport(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, accountId: string, generatedAt = new Date().toISOString()): RecoveryReport {
  const rows: RecoveryRow[] = []
  const remoteSessions = remote?.sessions ?? []
  const remoteComputers = remote?.computers ?? []
  const seenSessions = new Set<string>()
  const seenComputers = new Set<string>()

  const add = (kind: 'session' | 'computer', entry: InventorySession | ComputerRecord | undefined, match: InventorySession | ComputerRecord | undefined, candidates: ComputerRecord[] = []) => {
    const localId = entry?.id
    const remoteId = match?.cloudId || match?.id
    const pending = pendingFor(local.queue, kind, accountId, localId, remoteId)
    const localComputer = kind === 'computer' ? entry as ComputerRecord | undefined : undefined
    const remoteComputer = kind === 'computer' ? match as ComputerRecord | undefined : undefined
    const needsUpload = Boolean(localComputer?.photo && (localComputer.photoNeedsUpload || !localComputer.photoRemote))
    const remoteReferenceMissing = Boolean(localComputer?.photoRemote && match && !remoteComputer?.photoRemote)
    const changed = entry && match ? differences(entry, match) : []
    const ownerClass = classifyOwner(entry?.ownerId, match?.ownerId, Boolean(entry), Boolean(match), accountId)
    const recordOwner = entry?.ownerId ?? match?.ownerId
    const authorizedPhotoPending = pending.some((item) => item.operation === 'update-computer-photo' && item.ownerId === accountId)
    const foreignPending = pending.some((item) => item.foreign) || Boolean(pending.length && recordOwner && recordOwner !== accountId && !authorizedPhotoPending)
    const categories: RecoveryClassification[] = []
    if (entry && match) categories.push('exact-id')
    else if (entry && candidates.length) categories.push('probable-duplicate')
    else if (entry && !remote) categories.push('remote-unavailable')
    else categories.push(entry ? 'local-only' : 'remote-only')
    if (changed.length) categories.push('different')
    categories.push(ownerClass)
    if (foreignPending) categories.push('foreign-pending-operation')
    if (needsUpload || remoteReferenceMissing || localComputer?.photoStoredLocally && !localComputer.photo && !hasValidRemotePhoto(match)) categories.push('photo-pending')
    if (pending.length) categories.push('queue-pending')
    // Un registro de otra cuenta que coincide y no tiene otros problemas es solo informativo; si existe únicamente aquí, hay que revisarlo.
    const foreignLocalOnly = ownerClass === 'other-account-record' && Boolean(entry) && !match
    if (changed.length || ownerClass === 'owner-mismatch' || ownerClass === 'owner-missing' || foreignPending || foreignLocalOnly || candidates.length || !remote
      || pending.some((item) => item.operation.startsWith('delete-')) || remoteReferenceMissing) categories.push('manual-review')
    rows.push({
      kind, localId, remoteId: remoteId || (candidates.length === 1 ? candidates[0].cloudId || candidates[0].id : undefined),
      sessionId: localComputer?.sessionId || remoteComputer?.sessionId,
      ownerId: entry?.ownerId, remoteOwnerId: match?.ownerId,
      importedFromId: entry?.importedFrom?.id,
      categories, differences: changed,
      photo: { local: Boolean(localComputer?.photo), remoteFileId: remoteComputer?.photoRemote?.fileId || localComputer?.photoRemote?.fileId, needsUpload, remoteReferenceMissing },
      pending, localRevision: entry?.updatedAt, remoteRevision: match?.updatedAt,
      proposal: categories.includes('manual-review') || pending.length ? 'manual-review' : entry && !match ? 'create-after-review' : ownerClass === 'other-account-record' ? 'no-action' : 'keep'
    })
  }

  for (const session of local.sessions) {
    const match = remoteSessions.find((item) => item.id === (session.cloudId || session.id))
    if (match) seenSessions.add(match.id)
    add('session', session, match)
  }
  for (const computer of local.computers) {
    const match = remoteComputers.find((item) => item.id === (computer.cloudId || computer.id))
    if (match) seenComputers.add(match.id)
    const candidates = match ? [] : remoteComputers.filter((item) => sameKey(computer, item))
    add('computer', computer, match, candidates)
  }
  for (const session of remoteSessions.filter((item) => !seenSessions.has(item.id))) add('session', undefined, session)
  for (const computer of remoteComputers.filter((item) => !seenComputers.has(item.id))) add('computer', undefined, computer)

  // También conserva a la vista operaciones cuyos registros ya no están en ningún lado.
  for (const item of local.queue) {
    if (rows.some((row) => row.pending.some((pending) => pending.id === item.id))) continue
    rows.push({ kind: item.operation.includes('session') ? 'session' : 'computer', localId: item.entityId,
      remoteId: item.remoteId, sessionId: item.sessionId, ownerId: item.ownerId,
      categories: item.ownerId === accountId ? ['queue-pending', 'manual-review'] : ['queue-pending', 'foreign-pending-operation', 'manual-review'], differences: [],
      photo: { local: false, remoteFileId: item.photoFileId, needsUpload: false, remoteReferenceMissing: false },
      pending: [{ id: item.id, operation: item.operation, revision: item.revision, lastError: item.lastError, ownerId: item.ownerId, foreign: item.ownerId !== accountId }],
      proposal: 'manual-review' })
  }

  const counts = Object.fromEntries(RECOVERY_CLASSIFICATIONS.map((category) => [category, rows.filter((row) => row.categories.includes(category)).length])) as Record<RecoveryClassification, number>
  const ownership = { own: counts['own-record'], otherAccount: counts['other-account-record'], mismatch: counts['owner-mismatch'], missing: counts['owner-missing'],
    foreignPending: counts['foreign-pending-operation'], pendingOperations: local.queue.length }
  return { generatedAt, accountId, remoteAvailable: Boolean(remote), rows, counts, ownership,
    localCounts: { sessions: local.sessions.length, computers: local.computers.length, queue: local.queue.length },
    remoteCounts: remote ? { sessions: remote.sessions.length, computers: remote.computers.length } : undefined,
    writesEnabled: false }
}

/** Criterio de revisión: cuándo el diagnóstico exige decisión humana antes de cualquier escritura. */
export function needsRecoveryReview(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport) {
  // Una sola fuente de verdad: hay revisión pendiente exactamente cuando existe al menos un motivo explicable.
  return describeReviewReasons(local, remote, report).length > 0
}

export type ReviewReasonCode =
  | 'remote-unavailable' | 'queue-pending' | 'owner-mismatch' | 'owner-missing' | 'foreign-pending-operation' | 'probable-duplicate'
  | 'not-matched' | 'different' | 'photo-pending-own' | 'photo-pending-other-account' | 'photo-pending-no-owner' | 'manual-review'

export interface ReviewReason {
  code: ReviewReasonCode
  count: number
  /** Quién puede resolverlo: esta cuenta, otra cuenta o nadie desde este panel. */
  actor: 'this-account' | 'other-account' | 'none'
  /** Identificadores abreviados de las filas afectadas. */
  rows: Array<{ kind: 'session' | 'computer'; id: string; ownerId?: string }>
}

/**
 * Motivos exactos por los que la sincronización no puede reanudarse. Los registros de otra cuenta que coinciden sin
 * diferencias son informativos y no aparecen aquí; diferencias, fotos, operaciones pendientes, propietarios en conflicto
 * o ausentes, duplicados y lecturas remotas fallidas sí.
 */
export function describeReviewReasons(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport): ReviewReason[] {
  const reasons = new Map<ReviewReasonCode, ReviewReason>()
  const add = (code: ReviewReasonCode, actor: ReviewReason['actor'], row?: RecoveryRow) => {
    const reason = reasons.get(code) ?? { code, count: 0, actor, rows: [] }
    reason.count += 1
    if (row) reason.rows.push({ kind: row.kind, id: row.localId || row.remoteId || '?', ownerId: row.ownerId ?? row.remoteOwnerId })
    reasons.set(code, reason)
  }
  if (!remote) add('remote-unavailable', 'none')
  if (local.queue.length) for (const item of local.queue) add(item.ownerId === report.accountId ? 'queue-pending' : 'foreign-pending-operation', item.ownerId === report.accountId ? 'this-account' : 'other-account')
  for (const row of report.rows) {
    const owner = row.ownerId ?? row.remoteOwnerId
    const actor: ReviewReason['actor'] = owner === report.accountId ? 'this-account' : owner ? 'other-account' : 'none'
    let flagged = false
    const mark = (code: ReviewReasonCode, who: ReviewReason['actor'] = actor) => { add(code, who, row); flagged = true }
    if (row.categories.includes('owner-mismatch')) mark('owner-mismatch', 'none')
    if (row.categories.includes('owner-missing')) mark('owner-missing', 'none')
    if (row.categories.includes('foreign-pending-operation') && !local.queue.length) mark('foreign-pending-operation', 'other-account')
    if (row.categories.includes('probable-duplicate')) mark('probable-duplicate', 'none')
    if (Boolean(row.localId) && !row.categories.includes('exact-id') && !row.categories.includes('probable-duplicate')) mark('not-matched')
    if (row.differences.length > 0) mark('different')
    const localComputer = row.localId ? local.computers.find((computer) => computer.id === row.localId) : undefined
    const photoActor = localComputer?.photoPendingActorId
    if (Boolean(row.localId) && row.categories.includes('photo-pending')) mark(!owner ? 'photo-pending-no-owner' : actor === 'this-account' || photoActor === report.accountId ? 'photo-pending-own' : 'photo-pending-other-account')
    // Cualquier otra causa que haya marcado la fila para revisión manual y no esté explicada arriba.
    if (row.categories.includes('manual-review') && !flagged && !local.queue.length) mark('manual-review', 'none')
  }
  return [...reasons.values()]
}

export interface RecoveryReaders {
  local: () => Promise<RecoverySnapshot>
  remote: () => Promise<RemoteRecoverySnapshot>
}

/**
 * Diagnóstico de SOLO LECTURA: lee IndexedDB y el servidor y construye el informe. No sincroniza, no escribe en
 * IndexedDB ni en Firestore y no cambia ningún estado que permita escrituras; esta función no importa nada de la sincronización.
 */
// Sin conexión no se intenta leer Firebase (evita esperas largas): el diagnóstico se basa solo en los datos locales.
const defaultReaders: RecoveryReaders = {
  local: () => readLocalRecoverySnapshot(),
  remote: () => (typeof navigator !== 'undefined' && navigator.onLine === false ? Promise.reject(new Error('Sin conexión')) : readRemoteRecoverySnapshot())
}

export async function runRecoveryDiagnostic(accountId: string, readers: RecoveryReaders = defaultReaders, browser?: RecoveryReport['browser']) {
  const local = await readers.local()
  let remote: RemoteRecoverySnapshot | null = null
  try { remote = await readers.remote() } catch { /* no se usa caché como prueba remota */ }
  const report = buildRecoveryReport(local, remote, accountId)
  if (browser) report.browser = browser
  return { report, local, remote, needsReview: needsRecoveryReview(local, remote, report) }
}

/** Una sola transacción de lectura conserva el estado de registros y cola en el mismo instante. */
export async function readLocalRecoverySnapshot(): Promise<RecoverySnapshot> {
  const db = await getDatabase()
  const tx = db.transaction(['sessions', 'computers', 'syncQueue'], 'readonly')
  const [sessions, computers, queue] = await Promise.all([
    tx.objectStore('sessions').getAll(), tx.objectStore('computers').getAll(), tx.objectStore('syncQueue').getAll()
  ])
  await tx.done
  return { sessions, computers, queue }
}

/** Consulta al servidor; nunca confunde el caché offline de Firestore con una confirmación remota. */
export async function readRemoteRecoverySnapshot(): Promise<RemoteRecoverySnapshot> {
  if (!firestore) throw new Error('Firestore no está configurado')
  const [sessions, computers] = await Promise.all([
    getDocsFromServer(collection(firestore, 'inventorySessions')),
    getDocsFromServer(collection(firestore, 'inventoryComputers'))
  ])
  return {
    sessions: sessions.docs.map((item) => ({ ...item.data(), id: item.id, cloudId: item.id }) as InventorySession),
    computers: computers.docs.map((item) => ({ ...item.data(), id: item.id, cloudId: item.id }) as ComputerRecord)
  }
}

export async function exportRecoverySnapshot(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport) {
  const computers = await Promise.all(local.computers.map(async ({ photo, ...computer }) => ({
    ...computer, photoDataUrl: photo ? await photoToDataUrl(photo) : undefined
  })))
  const payload = JSON.stringify({ format: 'inventario-recovery-snapshot', version: 1, report, local: { sessions: local.sessions, computers, queue: local.queue }, remote })
  const bytes = new TextEncoder().encode(payload)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
  return { payload, sha256, size: bytes.length }
}
