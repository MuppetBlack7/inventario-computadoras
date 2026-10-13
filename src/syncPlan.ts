import type { RecoveryReport, RecoveryRow, RecoverySnapshot, RemoteRecoverySnapshot } from './recovery'
import { previewScope, type PermissionContext, type PreviewItem } from './recoveryPermissions'
import type { SyncQueueItem } from './types'

/**
 * Lógica pura del flujo «Sincronizar inventario»: resumen del estado, decisiones de la persona y propuesta de acciones.
 * Solo analiza: no escribe en IndexedDB, Firestore ni ImageKit. Nada se ejecuta sin la confirmación explícita del flujo.
 */

export type RecordChoice = 'keep-local' | 'use-remote' | 'upload-mine'

export interface SyncDecisions {
  /** Subir mis cambios locales pendientes (operaciones en la cola) o conservarlos localmente por ahora. */
  uploadMyChanges: boolean
  /** Equipos solo locales: conservarlos o preparar su subida (solo si son míos y no tienen conflicto ni duplicado). */
  localOnly: 'keep' | 'prepare'
  /** Registros solo en Firebase: descargarlos (sin eliminar nada local) u omitirlos por ahora. */
  remoteOnly: 'download' | 'skip'
  uploadPhotos: boolean
  /** Resolución por registro con cambios distintos en ambos lados. Por defecto se conserva la versión local. */
  perRecord: Record<string, RecordChoice>
}

export const defaultDecisions = (): SyncDecisions => ({ uploadMyChanges: true, localOnly: 'prepare', remoteOnly: 'download', uploadPhotos: true, perRecord: {} })

export interface RowRef { kind: 'session' | 'computer'; id: string; ownerId?: string }

export interface SyncOverview {
  connection: 'online' | 'offline' | 'remote-unavailable'
  myPendingOperations: number
  foreignPendingOperations: number
  localOnly: RowRef[]
  remoteOnly: RowRef[]
  different: Array<RowRef & { fields: string[]; hasPendingOperation: boolean; mine: boolean }>
  photos: { ownPending: RowRef[]; otherAccount: Array<RowRef & { ownerName: string }>; localBytesProtected: number }
  otherAccountRecords: number
  conflicts: Array<RowRef & { reason: string }>
}

const CONFLICTS = ['owner-mismatch', 'owner-missing', 'probable-duplicate'] as const
const CONFLICT_TEXT: Record<(typeof CONFLICTS)[number], string> = {
  'owner-mismatch': 'propietario distinto entre local y Firebase',
  'owner-missing': 'sin propietario',
  'probable-duplicate': 'posible duplicado por inventario o serie'
}

const short = (id: string) => id.slice(0, 22)
const rowId = (row: RecoveryRow) => row.localId || row.remoteId || '?'
const ownerOf = (row: RecoveryRow) => row.ownerId ?? row.remoteOwnerId

export function summarizeSync(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport, online: boolean): SyncOverview {
  const account = report.accountId
  const ref = (row: RecoveryRow): RowRef => ({ kind: row.kind, id: rowId(row), ownerId: ownerOf(row) })
  const ownerName = (row: RecoveryRow) => local.computers.find((computer) => computer.id === row.localId)?.ownerName || remote?.computers.find((computer) => computer.id === row.remoteId)?.ownerName || String(ownerOf(row) ?? '').slice(0, 8)
  const mine = local.queue.filter((item) => item.ownerId === account)
  return {
    connection: !online ? 'offline' : remote ? 'online' : 'remote-unavailable',
    myPendingOperations: mine.length,
    foreignPendingOperations: local.queue.length - mine.length,
    localOnly: report.rows.filter((row) => row.localId && row.categories.includes('local-only')).map(ref),
    remoteOnly: report.rows.filter((row) => !row.localId && row.categories.includes('remote-only')).map(ref),
    different: report.rows.filter((row) => row.differences.length > 0).map((row) => ({ ...ref(row), fields: row.differences, hasPendingOperation: row.pending.length > 0, mine: ownerOf(row) === account })),
    photos: {
      ownPending: local.computers.filter((computer) => (computer.photoPendingActorId || computer.ownerId) === account && computer.photo && (computer.photoNeedsUpload || !computer.photoRemote)).map((computer) => ({ kind: 'computer' as const, id: computer.id, ownerId: computer.ownerId })),
      otherAccount: report.rows.filter((row) => row.categories.includes('photo-pending') && ownerOf(row) && ownerOf(row) !== account && !local.computers.some((computer) => computer.id === row.localId && computer.photoPendingActorId === account)).map((row) => ({ ...ref(row), ownerName: ownerName(row) })),
      localBytesProtected: remote ? local.computers.filter((computer) => computer.photo && remote.computers.some((entry) => (entry.id === computer.id || entry.id === computer.cloudId) && !entry.photoRemote) && !computer.photoNeedsUpload).length : 0
    },
    otherAccountRecords: report.rows.filter((row) => row.categories.includes('other-account-record')).length,
    conflicts: report.rows.flatMap((row) => {
      const code = CONFLICTS.find((candidate) => row.categories.includes(candidate))
      return code ? [{ ...ref(row), reason: CONFLICT_TEXT[code] }] : []
    })
  }
}

/** «Todo está al día»: con conexión y sin nada pendiente, local, remoto, distinto, fotos propias ni conflictos. */
export const isUpToDate = (overview: SyncOverview) => overview.connection === 'online'
  && overview.myPendingOperations === 0 && overview.localOnly.length === 0 && overview.remoteOnly.length === 0
  && overview.different.length === 0 && overview.photos.ownPending.length === 0 && overview.conflicts.length === 0

export interface PendingSummary {
  /** Registros propios que todavía no se han enviado (operaciones en la cola y equipos solo locales). */
  records: number
  /** Fotografías propias con copia local que aún no se han subido. */
  photos: number
  /** `false` si no se pudo comparar con Firebase: los equipos solo locales pueden no estar contados. */
  reliable: boolean
  items: Array<RowRef & { operation: string }>
}

/** Cuántos registros y fotografías propios están pendientes, para la tarjeta «Tienes cambios guardados en este dispositivo». */
export function summarizePending(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport): PendingSummary {
  const account = report.accountId
  const items = new Map<string, RowRef & { operation: string }>()
  for (const item of local.queue) {
    if (item.ownerId !== account || item.operation === 'cleanup-photo') continue
    items.set(item.entityId, { kind: item.operation.includes('session') ? 'session' : 'computer', id: item.entityId, ownerId: item.ownerId, operation: item.operation })
  }
  if (remote) {
    for (const row of report.rows) {
      const owner = row.ownerId ?? row.remoteOwnerId
      if (row.localId && row.categories.includes('local-only') && owner === account && !items.has(row.localId)) items.set(row.localId, { kind: row.kind, id: row.localId, ownerId: owner, operation: 'solo-local' })
    }
  }
  const photos = local.computers.filter((computer) => (computer.photoPendingActorId || computer.ownerId) === account && computer.photo && (computer.photoNeedsUpload || !computer.photoRemote)).length
  return { records: items.size, photos, reliable: remote !== null, items: [...items.values()] }
}

export type PrimaryAction = 'upload' | 'offline' | 'reconnect' | 'up-to-date' | 'review'

/** Único botón principal de la parte superior, según el estado. */
export function primaryAction(overview: SyncOverview, pending: PendingSummary): PrimaryAction {
  if (overview.connection === 'offline') return 'offline'
  if (overview.connection === 'remote-unavailable') return 'reconnect'
  if (pending.records > 0 || pending.photos > 0) return 'upload'
  return isUpToDate(overview) ? 'up-to-date' : 'review'
}

/**
 * Resultado de cada operación intentada: lo que salió de la cola se considera hecho y lo que sigue en ella queda pendiente
 * con su error. Solo lectura; la cola no se modifica.
 */
export function describeOperationResults(attempted: PreviewItem[], queueAfter: SyncQueueItem[], ownerId: string) {
  const remaining = new Map(queueAfter.filter((item) => item.ownerId === ownerId).map((item) => [item.entityId, item]))
  const done: string[] = []
  const pending: string[] = []
  for (const item of attempted.slice(0, 60)) {
    const label = `${item.kind === 'session' ? 'sesión' : 'equipo'} ${item.id.slice(0, 22)}`
    const left = remaining.get(item.id)
    if (left) pending.push(`${label}: ${item.action} sigue pendiente${left.lastError ? ` (${left.lastError})` : ''}`)
    else done.push(`${label}: ${item.action === 'upload-photo' ? 'fotografía subida' : item.action} · hecho`)
  }
  return { done, pending }
}

export interface SyncProposal {
  allowed: boolean
  blockedBy: string[]
  steps: { enqueue: PreviewItem[]; download: PreviewItem[]; upload: PreviewItem[]; photos: PreviewItem[] }
  /** Lo que se conserva sin tocar, con el motivo. */
  kept: PreviewItem[]
  excludeIds: Set<string>
  /** Registros propios sin operación pendiente cuya subida se prepara (solo operaciones locales de la cola). */
  enqueueIds: string[]
  runDownload: boolean
  runUpload: boolean
  runPhotos: boolean
  /** Huella: si cambia entre la vista previa y la confirmación, no se ejecuta nada. */
  key: string
}

const fingerprint = (value: unknown) => {
  const text = JSON.stringify(value)
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  return `${text.length}:${hash.toString(16)}`
}

/**
 * Propuesta de acciones según las decisiones. Garantías:
 * - nunca incluye registros ni operaciones de otras cuentas;
 * - los conflictos de propietario, duplicados probables y registros sin propietario siempre se excluyen;
 * - los registros con diferencias se conservan localmente salvo que se resuelvan uno a uno;
 * - «usar la versión de Firebase» solo se aplica si el registro no tiene operaciones pendientes;
 * - «subir mi versión» solo para registros propios;
 * - las fotografías de otras cuentas se conservan como advertencia.
 */
export function buildProposal(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport, decisions: SyncDecisions, context: PermissionContext): SyncProposal {
  const account = report.accountId
  const excludeIds = new Set<string>()
  const kept: PreviewItem[] = []
  const download: PreviewItem[] = []
  const enqueueIds: string[] = []
  const enqueue: PreviewItem[] = []
  const myQueued = new Set(local.queue.filter((item) => item.ownerId === account).map((item) => item.entityId))
  const keep = (row: RecoveryRow, reason: string) => {
    for (const id of [row.localId, row.remoteId]) if (id) excludeIds.add(id)
    kept.push({ action: 'conservar', kind: row.kind, id: rowId(row), detail: reason })
  }
  const prepare = (row: RecoveryRow, detail: string) => {
    if (row.localId && !myQueued.has(row.localId) && !enqueueIds.includes(row.localId)) {
      enqueueIds.push(row.localId)
      enqueue.push({ action: 'preparar-subida', kind: row.kind, id: row.localId, detail })
    }
  }
  const explicitUploads = new Set<string>()

  // Primero los conflictos: sus registros (también el candidato remoto de un posible duplicado) quedan fuera de todo.
  for (const row of report.rows) {
    const conflict = CONFLICTS.find((code) => row.categories.includes(code))
    if (conflict) keep(row, `conflicto: ${CONFLICT_TEXT[conflict]}`)
  }
  for (const row of report.rows) {
    const owner = ownerOf(row)
    if (CONFLICTS.some((code) => row.categories.includes(code))) continue
    if (!row.localId && excludeIds.has(rowId(row))) { kept.push({ action: 'conservar', kind: row.kind, id: rowId(row), detail: 'coincide con un posible duplicado local: no se descarga' }); continue }
    if (row.localId && row.categories.includes('local-only')) {
      if (!remote) keep(row, 'sin lectura de Firebase: no se puede comprobar duplicados')
      else if (!owner) keep(row, 'sin propietario: no se reclama')
      else if (owner !== account) keep(row, 'pertenece a otra cuenta y solo existe aquí: esta cuenta no puede subirlo')
      else if (decisions.localOnly === 'prepare') { prepare(row, 'solo local: propiedad verificada y sin duplicados probables'); explicitUploads.add(row.localId) }
      else keep(row, 'solo local: se conserva en este dispositivo por ahora')
      continue
    }
    if (!row.localId && row.categories.includes('remote-only')) {
      if (decisions.remoteOnly === 'download') download.push({ action: 'create-local-copy', kind: row.kind, id: rowId(row), detail: owner && owner !== account ? 'de otra cuenta (solo lectura)' : undefined })
      else keep(row, 'solo en Firebase: no se descarga por ahora')
      continue
    }
    if (row.differences.length) {
      const id = rowId(row)
      const choice = decisions.perRecord[id] ?? 'keep-local'
      if (choice === 'use-remote' && row.pending.length === 0) download.push({ action: 'overwrite-local-copy', kind: row.kind, id, detail: `campos: ${row.differences.join(', ')}` })
      else if (choice === 'upload-mine' && owner === account && row.localId) { prepare(row, `subir mi versión (campos distintos: ${row.differences.join(', ')})`); explicitUploads.add(row.localId) }
      else keep(row, choice === 'use-remote' ? 'tiene operaciones pendientes: no se sobrescribe' : choice === 'upload-mine' ? 'no es un registro propio: no se sube' : `diferencias sin resolver (${row.differences.join(', ')}): se conserva la versión local`)
    }
  }
  // «Conservar localmente por ahora»: las operaciones pendientes existentes no se ejecutan (salvo las elegidas explícitamente).
  if (!decisions.uploadMyChanges) {
    for (const item of local.queue) {
      if (item.ownerId === account && item.operation !== 'update-computer-photo' && !explicitUploads.has(item.entityId)) {
        excludeIds.add(item.entityId)
        if (item.remoteId) excludeIds.add(item.remoteId)
      }
    }
    kept.push({ action: 'conservar', kind: 'computer', id: '*', detail: `${myQueued.size} operación(es) pendiente(s) propias se conservan en la cola sin ejecutarse` })
  }
  const upload = previewScope('push-own', local, remote, report, excludeIds)
  const photos = decisions.uploadPhotos && context.imageKitConfigured ? previewScope('upload-own-photos', local, remote, report, excludeIds) : { items: [] as PreviewItem[], excluded: previewScope('upload-own-photos', local, remote, report, excludeIds).excluded }
  if (decisions.uploadPhotos && !context.imageKitConfigured) kept.push({ action: 'conservar', kind: 'computer', id: '*', detail: 'ImageKit no está configurado: las fotografías se conservan en este dispositivo' })
  kept.push(...upload.excluded, ...photos.excluded)

  const blockedBy: string[] = remote ? [] : ['Firebase no respondió: no se puede comparar ni sincronizar']
  const steps = { enqueue, download, upload: upload.items, photos: photos.items }
  const runDownload = Boolean(remote) && download.length > 0
  const runUpload = Boolean(remote) && (upload.items.length > 0 || enqueueIds.length > 0)
  const runPhotos = Boolean(remote) && photos.items.length > 0
  return {
    allowed: blockedBy.length === 0 && (runDownload || runUpload || runPhotos),
    blockedBy: blockedBy.length || runDownload || runUpload || runPhotos ? blockedBy : ['No hay nada que sincronizar con las opciones elegidas'],
    steps, kept, excludeIds, enqueueIds, runDownload, runUpload, runPhotos,
    key: fingerprint([steps, kept, [...excludeIds].sort(), enqueueIds])
  }
}

export interface DifferenceField { field: string; label: string; local: string; remote: string }
export interface DifferenceOption { choice: RecordChoice; label: string; effect: string; available: boolean; reason?: string }
export interface DifferenceDetail {
  id: string
  kind: 'session' | 'computer'
  title: string
  ownerName: string
  mine: boolean
  hasPendingOperation: boolean
  fields: DifferenceField[]
  options: DifferenceOption[]
}

const FIELD_LABELS: Record<string, string> = {
  brand: 'Marca', model: 'Modelo', serialNumber: 'Número de serie', inventoryId: 'Número de inventario', equipmentType: 'Tipo de equipo',
  operatingSystem: 'Sistema operativo', ramGB: 'RAM (GB)', drives: 'Unidades', notes: 'Notas', writtenLocation: 'Ubicación escrita',
  manufacturingYear: 'Año de fabricación', yearUnknown: 'Año desconocido', photoRemote: 'Fotografía en ImageKit', name: 'Nombre', location: 'Ubicación', date: 'Fecha'
}

const formatValue = (field: string, value: unknown): string => {
  if (value === undefined || value === null || value === '') return field === 'photoRemote' ? 'sin fotografía subida' : 'vacío'
  if (field === 'photoRemote' && typeof value === 'object') return `fotografía subida (${String((value as { name?: string }).name ?? 'archivo')})`
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.length > 80 ? `${text.slice(0, 77)}…` : text
}

/** Describe, solo para mostrar, cada registro con cambios distintos: equipo, valores de ambos lados y opciones seguras. */
export function describeDifferences(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport): DifferenceDetail[] {
  const account = report.accountId
  return report.rows.filter((row) => row.differences.length > 0 && !CONFLICTS.some((code) => row.categories.includes(code))).map((row) => {
    const id = rowId(row)
    const pool = row.kind === 'computer' ? local.computers : local.sessions
    const remotePool = row.kind === 'computer' ? remote?.computers ?? [] : remote?.sessions ?? []
    const mineRecord = pool.find((item) => item.id === row.localId) as unknown as Record<string, unknown> | undefined
    const theirs = remotePool.find((item) => item.id === row.remoteId || item.cloudId === row.remoteId || item.id === row.localId) as unknown as Record<string, unknown> | undefined
    const owner = ownerOf(row)
    const mine = owner === account
    const hasPendingOperation = row.pending.length > 0
    const record = (mineRecord ?? theirs) as Record<string, unknown> | undefined
    const title = row.kind === 'computer'
      ? `Equipo ${String(record?.inventoryId || record?.serialNumber || short(id))}${record?.brand || record?.model ? ` · ${[record?.brand, record?.model].filter(Boolean).join(' ')}` : ''}`
      : `Sesión ${String(record?.name || short(id))}`
    const ownerName = String((record?.ownerName as string | undefined) || String(owner ?? '').slice(0, 8) || 'sin propietario')
    return {
      id, kind: row.kind, title, ownerName: mine ? 'tú' : ownerName, mine, hasPendingOperation,
      fields: row.differences.map((field) => ({ field, label: FIELD_LABELS[field] ?? field, local: formatValue(field, mineRecord?.[field]), remote: formatValue(field, theirs?.[field]) })),
      options: [
        { choice: 'keep-local', label: 'Conservar mi versión local', available: true, effect: 'No se escribe nada. La diferencia seguirá apareciendo hasta que la resuelvas.' },
        { choice: 'use-remote', label: 'Usar la versión de Firebase', available: !hasPendingOperation && Boolean(theirs),
          effect: 'Solo cambia la copia de este dispositivo: se actualizan los campos distintos con los de Firebase. Firebase, los propietarios y las fotografías locales no se tocan.',
          reason: hasPendingOperation ? 'hay operaciones pendientes sobre este registro; se conservarían tus cambios sin enviar' : !theirs ? 'no hay lectura de Firebase' : undefined },
        { choice: 'upload-mine', label: 'Subir mi versión', available: mine && Boolean(row.localId) && Boolean(theirs),
          effect: 'Firebase se actualizará con tu versión (solo es posible en registros tuyos).',
          reason: !mine ? `es un registro de ${ownerName}: solo su propietario puede modificarlo en Firebase` : undefined }
      ] as DifferenceOption[]
    }
  })
}

/** Por qué no hay nada ejecutable: motivos concretos y qué puede hacer la persona. Solo texto; no habilita nada. */
export function explainNoOperations(proposal: SyncProposal, details: DifferenceDetail[]): string[] {
  if (proposal.allowed) return []
  const reasons: string[] = []
  if (proposal.blockedBy.some((reason) => reason.startsWith('Firebase no respondió'))) { reasons.push('Firebase no respondió, así que no se puede comparar ni enviar nada.'); return reasons }
  const unresolved = details.length
  if (unresolved > 0) {
    const foreign = details.filter((item) => !item.mine).length
    reasons.push(`${unresolved} ${unresolved === 1 ? 'registro tiene' : 'registros tienen'} cambios distintos y está elegido conservar tu versión local: eso no escribe nada. Elige «Usar la versión de Firebase» o «Subir mi versión» en cada uno si quieres resolverlo.`)
    if (foreign > 0) reasons.push(`${foreign} ${foreign === 1 ? 'es de otra cuenta' : 'son de otras cuentas'}: no puedes subir tu versión, solo conservarla o usar la de Firebase en este dispositivo.`)
  }
  if (proposal.steps.upload.length === 0 && proposal.steps.photos.length === 0) reasons.push('No hay operaciones propias en cola ni fotografías propias que subir.')
  reasons.push('Tus datos siguen guardados en este dispositivo y no se pierde nada: puedes volver al inventario cuando quieras.')
  return reasons
}
