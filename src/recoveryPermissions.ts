import type { ComputerRecord } from './types'
import { describeReviewReasons, type RecoveryReport, type RecoveryRow, type RecoverySnapshot, type RemoteRecoverySnapshot, type ReviewReasonCode } from './recovery'

/**
 * Calcula qué operaciones pueden habilitarse por separado y qué se escribiría en cada una. Es solo análisis: no escribe en
 * IndexedDB, Firestore ni ImageKit. Habilitar un alcance exige una acción explícita con vista previa y confirmación.
 */
export type RecoveryScope = 'local-edits' | 'pull-remote' | 'push-own' | 'upload-own-photos' | 'foreign-operations'

export type ScopeBlocker = ReviewReasonCode | 'local-record-missing-remotely' | 'imagekit-not-configured' | 'nothing-to-upload' | 'owner-only-by-rules'

export interface ScopeDecision {
  scope: RecoveryScope
  allowed: boolean
  blockedBy: ScopeBlocker[]
  /** Avisos que permanecen visibles aunque el alcance esté permitido. */
  warnings: string[]
}

export interface PreviewItem {
  action: string
  kind: 'session' | 'computer'
  id: string
  detail?: string
}

export interface ScopePreview {
  scope: RecoveryScope
  /** Lo que se escribiría si se autoriza este alcance. */
  items: PreviewItem[]
  /** Lo que queda fuera por pertenecer a otra cuenta o por no poder ejecutarse. */
  excluded: PreviewItem[]
}

export interface PermissionContext { imageKitConfigured: boolean }

const ownerOf = (row: RecoveryRow) => row.ownerId ?? row.remoteOwnerId
const involvesAccount = (row: RecoveryRow, accountId: string) => row.ownerId === accountId || row.remoteOwnerId === accountId || (!row.ownerId && !row.remoteOwnerId)
const isForeignPhotoPending = (row: RecoveryRow, accountId: string) => row.categories.includes('photo-pending') && Boolean(ownerOf(row)) && ownerOf(row) !== accountId

const byIdOrCloud = <T extends { id: string; cloudId?: string }>(items: T[], id: string | undefined) => (id ? items.find((item) => item.id === id || item.cloudId === id) : undefined)

/**
 * Registros locales con bytes de fotografía cuyo documento remoto no tiene referencia. Antes la descarga los descartaba;
 * `applyRemoteComputer` ya los conserva, así que esto es solo informativo y no bloquea ningún alcance.
 */
export function photosAtRisk(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null) {
  if (!remote) return []
  return local.computers.filter((computer) => {
    const match = byIdOrCloud(remote.computers, computer.cloudId || computer.id)
    return Boolean(computer.photo) && Boolean(match) && !match!.photoRemote && !computer.photoNeedsUpload
  }).map((computer) => computer.id)
}

export function evaluateScopes(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport, context: PermissionContext): Record<RecoveryScope, ScopeDecision> {
  const account = report.accountId
  const reasons = describeReviewReasons(local, remote, report)
  const warnings: string[] = []
  const foreignPhotos = report.rows.filter((row) => isForeignPhotoPending(row, account)).length
  if (foreignPhotos) warnings.push(`${foreignPhotos} fotografía${foreignPhotos === 1 ? '' : 's'} pendiente${foreignPhotos === 1 ? '' : 's'} de otra cuenta: ${foreignPhotos === 1 ? 'permanece' : 'permanecen'} visible${foreignPhotos === 1 ? '' : 's'}, no se modifica${foreignPhotos === 1 ? '' : 'n'} ni se marca${foreignPhotos === 1 ? '' : 'n'} como recuperada${foreignPhotos === 1 ? '' : 's'}`)
  if (report.ownership.foreignPending) warnings.push(`${report.ownership.foreignPending} operación(es) pendiente(s) de otra cuenta: no se ejecutan ni se eliminan`)

  const blockersFor = (rowCodes: Array<'owner-mismatch' | 'owner-missing' | 'probable-duplicate' | 'different'>, scopedToAccount: boolean) => {
    const found = new Set<ScopeBlocker>()
    if (!remote) found.add('remote-unavailable')
    for (const row of report.rows) {
      if (scopedToAccount && !involvesAccount(row, account)) continue
      for (const code of rowCodes) {
        const present = code === 'different' ? row.differences.length > 0 : row.categories.includes(code)
        if (present) found.add(code)
      }
    }
    return [...found]
  }

  const pullBlockers = blockersFor(['owner-mismatch', 'owner-missing', 'probable-duplicate', 'different'], false)
  if (local.computers.some((computer) => computer.sharedCloud && report.rows.some((row) => row.localId === computer.id && row.categories.includes('local-only')))) pullBlockers.push('local-record-missing-remotely')

  const pushBlockers = blockersFor(['owner-mismatch', 'owner-missing', 'probable-duplicate', 'different'], true)
  const photoBlockers = [...pushBlockers]
  if (!context.imageKitConfigured) photoBlockers.push('imagekit-not-configured')
  if (!ownPhotoCandidates(local, account).length) photoBlockers.push('nothing-to-upload')

  const decision = (scope: RecoveryScope, blockedBy: ScopeBlocker[]): ScopeDecision => ({ scope, allowed: blockedBy.length === 0, blockedBy, warnings })
  return {
    'local-edits': decision('local-edits', []),
    'pull-remote': decision('pull-remote', pullBlockers),
    'push-own': decision('push-own', pushBlockers),
    'upload-own-photos': decision('upload-own-photos', photoBlockers),
    'foreign-operations': decision('foreign-operations', ['owner-only-by-rules'])
  }
}

const ownPhotoCandidates = (local: RecoverySnapshot, account: string): ComputerRecord[] =>
  local.computers.filter((computer) => computer.ownerId === account && Boolean(computer.photo) && (Boolean(computer.photoNeedsUpload) || !computer.photoRemote))

/** Equipos propios cuya fotografía se subiría, con el documento completo que acompaña a la subida. */
function photoUploadItems(local: RecoverySnapshot, report: RecoveryReport, exclude: ReadonlySet<string>) {
  const account = report.accountId
  const items: PreviewItem[] = []
  const excluded: PreviewItem[] = []
  for (const computer of ownPhotoCandidates(local, account)) {
    const queued = local.queue.find((item) => item.entityId === computer.id)
    // Una baja pendiente sobre el mismo equipo ocupa su lugar en la cola: no hay subida.
    if (queued && queued.operation !== 'upsert-computer') {
      excluded.push({ action: 'upload-photo', kind: 'computer', id: computer.id, detail: `tiene una operación pendiente ${queued.operation}: no se sube la foto` })
      continue
    }
    if (exclude.has(computer.id) || (computer.cloudId && exclude.has(computer.cloudId))) {
      excluded.push({ action: 'upload-photo', kind: 'computer', id: computer.id, detail: 'excluido por conflicto o riesgo' })
      continue
    }
    const row = report.rows.find((entry) => entry.localId === computer.id)
    const changes = row?.differences.length ? `campos distintos que se escribirán: ${row.differences.join(', ')}` : row?.categories.includes('local-only') ? 'documento nuevo en Firestore' : 'sin cambios de datos respecto a Firestore'
    items.push({ action: 'upload-photo', kind: 'computer', id: computer.id, detail: `${computer.photo?.size ?? 0} bytes` })
    items.push({ action: 'write-document', kind: 'computer', id: computer.id, detail: `${changes}; ${queued ? 'ya tiene una operación pendiente en la cola' : 'se encolará una operación local'}` })
  }
  for (const row of report.rows) if (isForeignPhotoPending(row, account)) excluded.push({ action: 'upload-photo', kind: 'computer', id: row.localId || row.remoteId || '?', detail: 'fotografía de otra cuenta: solo su propietario puede subirla' })
  return { items, excluded }
}

/** Vista previa de lo que cada alcance escribiría. Solo lectura: no ejecuta ni encola nada. */
export function previewScope(scope: RecoveryScope, local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport, exclude: ReadonlySet<string> = new Set()): ScopePreview {
  const account = report.accountId
  const items: PreviewItem[] = []
  const excluded: PreviewItem[] = []
  if (scope === 'push-own') {
    for (const item of local.queue) {
      const kind = item.operation.includes('session') ? 'session' : 'computer'
      const target = kind === 'session' ? byIdOrCloud(local.sessions, item.entityId) : byIdOrCloud(local.computers, item.entityId)
      const targetOwner = target?.ownerId ?? (kind === 'session' ? byIdOrCloud(remote?.sessions ?? [], item.remoteId || item.entityId)?.ownerId : byIdOrCloud(remote?.computers ?? [], item.remoteId || item.entityId)?.ownerId)
      const entry: PreviewItem = { action: item.operation, kind, id: item.entityId, detail: `reintentos: ${item.attempts ?? 0}` }
      if (item.ownerId !== account) excluded.push({ ...entry, detail: 'operación de otra cuenta o sin propietario: no se ejecuta' })
      else if (targetOwner && targetOwner !== account) excluded.push({ ...entry, detail: 'afecta a un registro de otra cuenta: permanece bloqueada' })
      else if (exclude.has(item.entityId) || (item.remoteId && exclude.has(item.remoteId))) excluded.push({ ...entry, detail: 'excluido por conflicto o riesgo' })
      // Las limpiezas de archivos de ImageKit no se ejecutan en este alcance: quedan en la cola.
      else if (item.operation === 'cleanup-photo') excluded.push({ ...entry, detail: 'limpieza de ImageKit: no se ejecuta en este paso y permanece en la cola' })
      else items.push({ ...entry, detail: `${entry.detail}${item.operation === 'upsert-computer' && ownPhotoCandidates(local, account).some((computer) => computer.id === item.entityId) ? '; su fotografía pendiente NO se sube en este paso' : ''}` })
    }
  } else if (scope === 'upload-own-photos') {
    const result = photoUploadItems(local, report, exclude)
    items.push(...result.items)
    excluded.push(...result.excluded)
  } else if (scope === 'pull-remote') {
    for (const row of report.rows) {
      const id = row.localId || row.remoteId || '?'
      if (exclude.has(id) || (row.remoteId && exclude.has(row.remoteId))) { excluded.push({ action: 'download', kind: row.kind, id, detail: 'excluido por conflicto o riesgo' }); continue }
      if (!row.localId && row.remoteId) items.push({ action: 'create-local-copy', kind: row.kind, id })
      else if (row.differences.length) items.push({ action: 'overwrite-local-copy', kind: row.kind, id, detail: `campos: ${row.differences.join(', ')}` })
    }
  }
  // local-edits y foreign-operations no escriben en Firestore: sin elementos que previsualizar.
  return { scope, items, excluded }
}

export type ControlId = 'local-files' | 'keep-stopped' | 'photos' | 'all'

export interface AllPlan {
  allowed: boolean
  blockedBy: ScopeBlocker[]
  /** Registros que «Actualizar todos» no tocará: conflictos, duplicados, propietario dudoso o riesgo de pérdida. */
  excludeIds: Set<string>
  steps: { pull: PreviewItem[]; operations: PreviewItem[]; photos: PreviewItem[] }
  excluded: PreviewItem[]
}

const CONFLICT_CODES = ['owner-mismatch', 'owner-missing', 'probable-duplicate'] as const

/**
 * «Actualizar todos los equipos»: concilia primero (descarga), después sube mis operaciones y mis fotografías, y excluye
 * cualquier registro con conflicto de propietario, duplicado probable, contenido distinto o propietario ausente.
 * Nunca incluye registros ni operaciones de otras cuentas.
 */
export function planUpdateAll(local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport, context: PermissionContext): AllPlan {
  const excludeIds = new Set<string>()
  const excluded: PreviewItem[] = []
  for (const row of report.rows) {
    const reason = CONFLICT_CODES.find((code) => row.categories.includes(code)) ?? (row.differences.length ? 'different' : undefined)
    if (!reason) continue
    for (const id of [row.localId, row.remoteId]) if (id) excludeIds.add(id)
    excluded.push({ action: 'skip', kind: row.kind, id: row.localId || row.remoteId || '?', detail: `excluido por ${reason === 'different' ? `contenido distinto (${row.differences.join(', ')})` : reason}` })
  }
  const pull = previewScope('pull-remote', local, remote, report, excludeIds)
  const operations = previewScope('push-own', local, remote, report, excludeIds)
  const photos = previewScope('upload-own-photos', local, remote, report, excludeIds)
  excluded.push(...pull.excluded, ...operations.excluded, ...photos.excluded)
  const blockedBy: ScopeBlocker[] = []
  if (!remote) blockedBy.push('remote-unavailable')
  return {
    allowed: blockedBy.length === 0,
    blockedBy,
    excludeIds,
    steps: { pull: pull.items, operations: operations.items, photos: context.imageKitConfigured ? photos.items : [] },
    excluded
  }
}

export interface ControlPreview {
  items: PreviewItem[]
  excluded: PreviewItem[]
  notes: string[]
  /** Huella de la vista previa: si cambia entre la vista previa y la confirmación, la acción no se ejecuta. */
  key: string
}

const fingerprint = (items: PreviewItem[], excluded: PreviewItem[]) => {
  const text = JSON.stringify([items, excluded])
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  return `${items.length}:${excluded.length}:${hash.toString(16)}`
}

/** Vista previa exacta de un control: lo mismo que ejecutará la acción, incluidos los documentos que acompañan a las fotos. */
export function previewControl(control: ControlId, local: RecoverySnapshot, remote: RemoteRecoverySnapshot | null, report: RecoveryReport, context: PermissionContext): ControlPreview {
  const done = (items: PreviewItem[], excluded: PreviewItem[], notes: string[]): ControlPreview => ({ items, excluded, notes, key: fingerprint(items, excluded) })
  if (control === 'keep-stopped') {
    return done([], [], [`No se escribirá nada en Firestore ni en ImageKit. La cola actual (${local.queue.length} operación${local.queue.length === 1 ? '' : 'es'}) se conserva sin ejecutarse y los cambios nuevos solo se guardarán aquí; no se enviarán mientras la sincronización siga detenida.`])
  }
  const revalidated = report.rows.filter((row) => row.localId && row.remoteId && !row.differences.length).length
  if (control === 'local-files') {
    const pull = previewScope('pull-remote', local, remote, report)
    return done(pull.items, pull.excluded, ['Solo cambia la copia local; no se escribe en Firestore ni se elimina ningún registro local.', `${revalidated} registros ya iguales se revalidan sin cambiar su contenido (si Firestore no ha cambiado, no se reescriben).`])
  }
  if (control === 'photos') {
    const photos = previewScope('upload-own-photos', local, remote, report)
    return done(photos.items, photos.excluded, ['Se escribirá en ImageKit (la fotografía) y en Firestore (el documento COMPLETO del equipo, incluidos sus cambios de datos pendientes, y la referencia de la foto).', 'Solo equipos tuyos; las fotografías de otras cuentas no se tocan.'])
  }
  const plan = planUpdateAll(local, remote, report, context)
  const items = [
    ...plan.steps.pull.map((item) => ({ ...item, action: `1·descargar:${item.action}` })),
    ...plan.steps.operations.map((item) => ({ ...item, action: `2·subir:${item.action}` })),
    ...plan.steps.photos.map((item) => ({ ...item, action: `3·${item.action}` }))
  ]
  return done(items, plan.excluded, [
    'Orden: 1) descargar, 2) subir mis operaciones (sin fotografías ni limpiezas de ImageKit), 3) subir mis fotografías.',
    'En el paso 3 se vuelve a escribir el documento completo de cada equipo con foto. Los registros excluidos no se tocan en ningún paso.'
  ])
}
