import { describe, expect, it } from 'vitest'
import { contentDifferences, pairImportedCopies, planOwnershipTransfer, type PairingReport } from './importPairing'
import { sharedRecordId } from './sharedImport'
import type { ComputerRecord } from './types'

const stamp = '2026-01-01T00:00:00Z'
const base = (id: string, changes: Partial<ComputerRecord> = {}): ComputerRecord => ({
  id, sessionId: 's1', inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  brand: 'Marca', model: 'Modelo', manufacturingYear: null, yearUnknown: true, operatingSystem: '', ramGB: 8,
  drives: [{ id: 'd1', capacityGB: 500, type: 'HDD' }], originalCode: '', scannedAt: stamp, timezone: 'UTC', latitude: null, longitude: null,
  accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'friend', createdAt: stamp, updatedAt: stamp, ...changes
})
const original = (id: string, changes: Partial<ComputerRecord> = {}) => base(id, { photo: new Blob([id]), ...changes })
const copyOf = (id: string, changes: Partial<ComputerRecord> = {}) => base(sharedRecordId('mine', id), {
  ownerId: 'mine', importedFrom: { id, importedAt: stamp }, photo: new Blob([id]),
  inventoryId: `INV-${id}`, inventoryNormalized: `INV${id}`, serialNumber: `SER-${id}`, serialNormalized: `SER${id}`,
  photoRemote: { fileId: `f-${id}`, url: 'https://x/y', filePath: `/inventario/mine/${id}.jpg`, name: 'y', size: 1, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: stamp },
  ...changes
})
const report = (originals: ComputerRecord[], copies: ComputerRecord[], photoDigests: Record<string, string> = {}) => pairImportedCopies({ originals, copies, photoDigests })
const strip = (records: ComputerRecord[]) => records.map(({ photo: _photo, ...rest }) => rest)

describe('emparejamiento de copias importadas', () => {
  it('empareja por importedFrom.id y no por serie, inventario o foto', () => {
    const originals = [original('a'), original('b')]
    // La copia declara el ID de «a»: aunque su serie e inventario coinciden con «b», el emparejamiento sigue al ID declarado.
    const swapped = copyOf('a', { serialNumber: 'SER-b', serialNormalized: 'SERb', inventoryId: 'INV-b', inventoryNormalized: 'INVb' })
    const result = report(originals, [swapped])
    expect(result.rows[0]).toMatchObject({ status: 'paired', originalId: 'a' })
    expect(result.rows[0].aux).toMatchObject({ serialEqual: false, inventoryEqual: false })
    expect(result.originalsWithoutCopy).toEqual(['b'])
  })

  it('misma serie e inventario sin importedFrom no forma pareja', () => {
    expect(report([original('c')], [base('imp-x-c', { ownerId: 'mine' })]).rows).toEqual([])
  })

  it('una copia sin original o con original ambiguo se marca y nunca se empareja automáticamente', () => {
    expect(report([], [copyOf('z')]).rows[0].status).toBe('copy-without-original')
    expect(report([original('a'), original('a')], [copyOf('a')]).rows[0].status).toBe('ambiguous-original')
    const twice = report([original('a')], [copyOf('a'), { ...copyOf('a'), id: 'imp-mine-otra' }])
    expect(twice.rows.map((row) => row.status)).toEqual(['ambiguous-original', 'ambiguous-original'])
  })

  it('detecta diferencias reales de contenido pero ignora IDs, propietario, fechas, estado y el orden de claves anidadas', () => {
    const a = original('a')
    const equal = copyOf('a', { drives: [{ type: 'HDD', id: 'd1', capacityGB: 500 }], updatedAt: '2030-01-01T00:00:00Z', syncStatus: 'synced' })
    expect(contentDifferences(a, equal)).toEqual([])
    expect(contentDifferences(a, copyOf('a', { notes: 'cambiada', ramGB: 16 }))).toEqual(['notes', 'ramGB'])
    expect(report([a], [copyOf('a', { notes: 'x' })]).rows[0].differences).toEqual(['notes'])
  })

  it('compara fotografías solo como comprobación auxiliar y reporta su estado', () => {
    const a = original('a')
    const result = report([a], [copyOf('a')], { a: 'h1', 'imp-mine-a': 'h1' })
    expect(result.rows[0].aux.photoDigestEqual).toBe(true)
    expect(result.rows[0].photo).toEqual({ originalHasBytes: true, copyHasBytes: true, copyHasRemoteReference: true, originalHasRemoteReference: false })
    expect(report([a], [copyOf('a')], { a: 'h1', 'imp-mine-a': 'h2' }).rows[0].aux.photoDigestEqual).toBe(false)
  })
})

describe('plan de transferencia (solo datos, sin ejecución)', () => {
  const ids = ['a', 'b', 'c']
  const pairing = () => report(ids.map((id) => original(id)), ids.map((id) => copyOf(id)))
  const kinds = (steps: ReturnType<typeof planOwnershipTransfer>) => steps.map((step) => step.kind)

  it('empieza preservando el respaldo y no propone retirar copias hasta verificar todo', () => {
    const steps = planOwnershipTransfer(pairing())
    expect(steps[0]).toMatchObject({ kind: 'preserve-backup' })
    expect(kinds(steps)).not.toContain('importer-retire-copy')
    expect(steps.filter((step) => step.kind === 'owner-publish-original').map((step) => step.actor)).toEqual(['owner', 'owner', 'owner'])
  })

  it('nunca incluye operaciones que cambien el propietario o creen identificadores nuevos', () => {
    const everything = planOwnershipTransfer(pairing(), { backupPreserved: true, publishedOriginals: new Set(ids), verifiedPhotos: new Set(ids) })
    const allowed = new Set(['preserve-backup', 'owner-verify-original', 'owner-publish-original', 'owner-verify-photo', 'importer-retire-copy', 'blocked'])
    expect(everything.every((step) => allowed.has(step.kind))).toBe(true)
    expect(JSON.stringify(everything)).not.toMatch(/change-owner|transfer-owner|create-new|ownerId/)
    expect(new Set(everything.map((step) => step.originalId))).toEqual(new Set(ids))
  })

  it('la copia solo se retira cuando el original está publicado y su fotografía verificada, y lo hace quien importó', () => {
    const steps = planOwnershipTransfer(pairing(), { backupPreserved: true, publishedOriginals: new Set(['a', 'b']), verifiedPhotos: new Set(['a']) })
    expect(steps.filter((step) => step.kind === 'importer-retire-copy')).toEqual([{ kind: 'importer-retire-copy', actor: 'importer', copyId: sharedRecordId('mine', 'a'), originalId: 'a' }])
    expect(steps.find((step) => step.originalId === 'b' && step.kind === 'owner-verify-photo')).toBeTruthy()
    expect(steps.find((step) => step.originalId === 'c' && step.kind === 'owner-publish-original')).toBeTruthy()
  })

  it('sin la copia de seguridad preservada no se retira nada aunque todo esté verificado', () => {
    const steps = planOwnershipTransfer(pairing(), { backupPreserved: false, publishedOriginals: new Set(ids), verifiedPhotos: new Set(ids) })
    expect(kinds(steps)).not.toContain('importer-retire-copy')
  })

  it('una foto sin verificar bloquea el retiro: no se pierde la fotografía', () => {
    const steps = planOwnershipTransfer(pairing(), { backupPreserved: true, publishedOriginals: new Set(ids), verifiedPhotos: new Set() })
    expect(kinds(steps)).not.toContain('importer-retire-copy')
    expect(steps.filter((step) => step.kind === 'owner-verify-photo')).toHaveLength(3)
  })

  it('las copias sin pareja o con diferencias quedan bloqueadas y nunca se retiran', () => {
    const rows = report([original('a'), original('b')], [copyOf('a', { notes: 'distinta' }), copyOf('b'), copyOf('huerfana')])
    const steps = planOwnershipTransfer(rows, { backupPreserved: true, publishedOriginals: new Set(['a', 'b']), verifiedPhotos: new Set(['a', 'b']) })
    expect(steps.filter((step) => step.kind === 'blocked').map((step) => step.originalId).sort()).toEqual(['a', 'huerfana'])
    expect(steps.filter((step) => step.kind === 'importer-retire-copy').map((step) => step.originalId)).toEqual(['b'])
  })

  it('es idempotente: repetir el análisis y el plan produce lo mismo y no modifica los datos', () => {
    const originals = ids.map((id) => original(id))
    const copies = ids.map((id) => copyOf(id))
    const before = JSON.stringify([strip(originals), strip(copies)])
    const checks = { backupPreserved: true, publishedOriginals: new Set(['a']), verifiedPhotos: new Set(['a']) }
    const first = planOwnershipTransfer(pairImportedCopies({ originals, copies }), checks)
    const second = planOwnershipTransfer(pairImportedCopies({ originals, copies }), checks)
    expect(second).toEqual(first)
    expect(JSON.stringify([strip(originals), strip(copies)])).toBe(before)
    // Tras retirar la copia de «a», repetir no produce pasos nuevos para ella.
    const afterRetirement = planOwnershipTransfer(pairImportedCopies({ originals, copies: copies.filter((copy) => copy.importedFrom?.id !== 'a') }), checks)
    expect(afterRetirement.some((step) => step.originalId === 'a')).toBe(false)
  })

  it('un informe vacío no genera pasos de escritura', () => {
    const empty: PairingReport = { rows: [], originalsWithoutCopy: [] }
    expect(planOwnershipTransfer(empty, { backupPreserved: true })).toEqual([])
  })
})
