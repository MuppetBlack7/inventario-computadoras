import 'fake-indexeddb/auto'
import ExcelJS from 'exceljs'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBackup, restoreBackup } from './backup'
import { buildInventoryWorkbook, INVENTORY_EXCEL_HEADERS } from './exportExcel'
import {
  clearAllData,
  claimLocalData,
  deleteSessionAndComputers,
  findDuplicates,
  getDatabase,
  getPendingSyncQueue,
  listComputers,
  listSessions,
  listVisibleComputers,
  listVisibleSessions,
  queueLocalPhotoMigrations,
  saveComputer,
  saveSession
} from './db'
import { parseScannedCode } from './qr'
import { pendingCount } from './cloudSync'
import type { ComputerRecord, InventorySession } from './types'
import { displayEquipmentType, normalizeKey } from './utils'
import { isAppleMobilePlatform } from './authPlatform'
import { describeFirebaseAuthError } from './firebaseClient'

const session: InventorySession = {
  id: 'session-test', name: 'Sesión de prueba', date: '2026-10-09', location: 'Laboratorio',
  ownerId: 'alice', ownerName: 'Alice', ownerEmail: 'alice@example.com',
  createdAt: '2026-10-09T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z'
}

const computer: ComputerRecord = {
  id: 'computer-test', sessionId: session.id, inventoryId: 'INV-001', inventoryNormalized: normalizeKey('INV-001'),
  equipmentType: 'Laptop', ownerId: 'alice', ownerName: 'Alice', ownerEmail: 'alice@example.com',
  serialNumber: 'SN-001', serialNormalized: normalizeKey('SN-001'), photo: new Blob(['foto'], { type: 'image/jpeg' }), photoName: 'foto.jpg',
  brand: 'Marca', model: 'Modelo', manufacturingYear: null, yearUnknown: true, operatingSystem: 'Windows 11', ramGB: 16,
  drives: [{ id: 'drive-1', capacityGB: 512, type: 'SSD' }], originalCode: 'SN:SN-001', scannedAt: '2026-10-09T12:00:00.000Z',
  timezone: 'America/Mazatlan', latitude: 24.8, longitude: -107.4, accuracyMeters: 12, writtenLocation: 'Laboratorio 1', notes: 'Prueba',
  createdAt: '2026-10-09T12:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z'
}

beforeEach(async () => { await clearAllData() })

describe('inventario local', () => {
  it('usa redirección en iPhone y en iPadOS con agente de macOS', () => {
    expect(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5 })).toBe(true)
    expect(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(isAppleMobilePlatform({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
  })

  it('expone los errores de Firebase Auth de forma visible y útil', () => {
    expect(describeFirebaseAuthError({ code: 'auth/unauthorized-domain', message: 'ignored' })).toContain('auth/unauthorized-domain')
    expect(describeFirebaseAuthError({ code: 'auth/operation-not-allowed', message: 'ignored' })).toContain('Google')
  })

  it('crea sesiones, guarda equipos y persiste al volver a consultar', async () => {
    await saveSession(session)
    await saveComputer(computer)
    expect(await listSessions()).toHaveLength(1)
    const stored = await listComputers(session.id)
    expect(stored).toHaveLength(1)
    expect(stored[0].serialNumber).toBe('SN-001')
    await saveComputer({ ...stored[0], model: 'Modelo editado' })
    expect((await listComputers(session.id))[0].model).toBe('Modelo editado')
  })

  it('detecta duplicados normalizando serie e inventario', async () => {
    await saveSession(session)
    await saveComputer(computer)
    expect(await findDuplicates('inv 001', '')).toHaveLength(1)
    expect(await findDuplicates('', 'sn_001')).toHaveLength(1)
    expect(await findDuplicates('otro', 'otra')).toHaveLength(0)
  })

  it('guarda, limpia y muestra un tipo de equipo personalizado', async () => {
    await saveSession(session)
    await saveComputer({ ...computer, equipmentType: 'Otro', customEquipmentType: 'Servidor' })
    let stored = (await listComputers())[0]
    expect(displayEquipmentType(stored)).toBe('Servidor')
    await saveComputer({ ...stored, equipmentType: '', customEquipmentType: '' })
    stored = (await listComputers())[0]
    expect(displayEquipmentType(stored)).toBe('')
  })

  it('elimina una sesión, sus equipos y deja operaciones de borrado para sincronizar', async () => {
    await saveSession({ ...session, cloudId: 'remote-session' })
    await saveComputer({ ...computer, cloudId: 'remote-computer', photoRemote: { fileId: 'file-1', url: 'https://example.com/foto.jpg', filePath: '/foto.jpg', name: 'foto.jpg', size: 4, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: '2026-10-09T12:00:00.000Z' } })
    await deleteSessionAndComputers(session.id, 'alice')
    expect(await listSessions()).toHaveLength(0)
    expect(await listComputers()).toHaveLength(0)
    const pending = await getPendingSyncQueue()
    expect(pending.map((item) => item.operation).sort()).toEqual(['cleanup-photo', 'delete-computer', 'delete-session'])
    expect(pending.find((item) => item.operation === 'delete-computer')).toMatchObject({ remoteId: 'remote-computer', photoFileId: 'file-1' })
    expect(pending.find((item) => item.operation === 'cleanup-photo')).toMatchObject({
      remoteId: 'remote-computer',
      photoFileId: 'file-1',
      ownerId: 'alice',
      cleanupReason: 'deleted-computer',
      blockedByQueueItemId: 'computer:computer-test'
    })
  })

  it('elimina una sesión vacía dejando solo el borrado de la sesión', async () => {
    await saveSession({ ...session, cloudId: 'remote-empty' })
    await deleteSessionAndComputers(session.id, 'alice')
    expect((await getPendingSyncQueue()).map((item) => item.operation)).toEqual(['delete-session'])
  })

  it('encola por separado las fotos de varios equipos y conserva la cola al reabrir IndexedDB', async () => {
    await saveSession({ ...session, cloudId: 'remote-many' })
    for (const number of [1, 2]) {
      await saveComputer({
        ...computer,
        id: `computer-${number}`,
        cloudId: `remote-${number}`,
        photoRemote: { fileId: `file-${number}`, url: `https://example.com/${number}.jpg`, filePath: `/inventario/alice/${number}.jpg`, name: `${number}.jpg`, size: 4, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: computer.updatedAt }
      })
    }
    await deleteSessionAndComputers(session.id, 'alice')
    let pending = await getPendingSyncQueue()
    expect(pending.filter((item) => item.operation === 'delete-computer')).toHaveLength(2)
    expect(pending.filter((item) => item.operation === 'cleanup-photo')).toHaveLength(2)
    ;(await getDatabase()).close()
    pending = await getPendingSyncQueue()
    expect(pending.filter((item) => item.operation === 'cleanup-photo').map((item) => item.photoFileId).sort()).toEqual(['file-1', 'file-2'])
  })

  it('elimina de forma idempotente una sesión creada solo sin conexión', async () => {
    await saveSession({ ...session, cloudId: undefined, sharedCloud: false })
    await saveComputer({ ...computer, cloudId: undefined, sharedCloud: false, photoRemote: undefined })
    await deleteSessionAndComputers(session.id, 'alice')
    const pending = await getPendingSyncQueue()
    expect(pending.map((item) => item.operation).sort()).toEqual(['delete-computer', 'delete-session'])
    expect(pending.every((item) => !item.remoteId)).toBe(true)
  })

  it('muestra el inventario local compartido al iniciar sesión y aísla la cola offline por creador', async () => {
    await saveSession({ ...session, id: 'alice-session', ownerId: 'alice' })
    await saveSession({ ...session, id: 'bob-session', ownerId: 'bob' })
    await saveSession({ ...session, id: 'local-session', ownerId: undefined })
    await saveComputer({ ...computer, id: 'alice-computer', sessionId: 'alice-session', ownerId: 'alice' })
    await saveComputer({ ...computer, id: 'bob-computer', sessionId: 'bob-session', ownerId: 'bob' })
    expect((await listVisibleSessions('alice')).map((item) => item.id).sort()).toEqual(['alice-session', 'bob-session', 'local-session'])
    expect((await listVisibleSessions('bob')).map((item) => item.id).sort()).toEqual(['alice-session', 'bob-session', 'local-session'])
    expect((await listVisibleSessions(null))).toEqual([])
    expect((await listVisibleComputers('alice')).map((item) => item.id).sort()).toEqual(['alice-computer', 'bob-computer'])
    expect((await getPendingSyncQueue()).length).toBeGreaterThanOrEqual(5)
    expect(await pendingCount('alice')).toBe(2)
    expect(await pendingCount('bob')).toBe(2)
    expect(await pendingCount(null)).toBe(1)
  })

  it('asigna registros locales al usuario sin borrarlos', async () => {
    await saveSession({ ...session, ownerId: undefined, ownerName: undefined, ownerEmail: undefined })
    await saveComputer({ ...computer, ownerId: undefined, ownerName: undefined, ownerEmail: undefined })
    await claimLocalData('owner-1', 'Propietario', 'owner@example.com')
    expect((await listSessions())[0].ownerId).toBe('owner-1')
    expect((await listComputers())[0].ownerId).toBe('owner-1')
  })

  it('interpreta QR estructurado y captura simple', () => {
    const parsed = parseScannedCode('{"inventario":"QR-1","serie":"SER-9","ramGB":8,"unidades":[{"capacidadGB":256,"tipo":"SSD"}]}')
    expect(parsed.inventoryId).toBe('QR-1')
    expect(parsed.ramGB).toBe(8)
    expect(parsed.drives?.[0].capacityGB).toBe(256)
    expect(parseScannedCode('SN:ABC-123').serialNumber).toBe('ABC-123')
  })

  it('respalda, borra y restaura datos y fotografía', async () => {
    await saveSession(session)
    await saveComputer(computer)
    const backup = await createBackup('alice')
    expect(backup.computers[0].photoDataUrl).toContain('data:image/jpeg;base64,')
    await clearAllData()
    expect(await listComputers()).toHaveLength(0)
    await restoreBackup(backup, true, 'alice')
    const restored = await listComputers()
    expect(restored).toHaveLength(1)
    expect(restored[0].photo?.size).toBe(4)
  })

  it('prepara fotografías locales del creador sin borrar el original', async () => {
    await saveComputer({ ...computer, syncStatus: 'synced', photoRemote: undefined })
    expect(await queueLocalPhotoMigrations('alice')).toBe(1)
    const stored = (await listComputers())[0]
    expect(stored.photo?.size).toBe(4)
    expect(stored.photoNeedsUpload).toBe(true)
    expect(stored.photoUploadStatus).toBe('pending')
  })

  it('genera un Excel válido con todos los registros y miniatura', async () => {
    await saveSession(session)
    await saveComputer({ ...computer, equipmentType: 'Otro', customEquipmentType: 'Servidor' })
    const result = await buildInventoryWorkbook(undefined, 'alice')
    expect(result.rows).toBe(1)
    expect(result.filename.endsWith('.xlsx')).toBe(true)
    expect(result.buffer.byteLength).toBeGreaterThan(1000)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(result.buffer)
    const worksheet = workbook.getWorksheet('Inventario')!
    expect(worksheet.getRow(1).values.slice(1)).toEqual([...INVENTORY_EXCEL_HEADERS])
    expect(worksheet.columnCount).toBe(8)
    expect(worksheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect(worksheet.getImages()).toHaveLength(1)
    expect(worksheet.getCell('F2').value).toBe('16 GB')
    expect(worksheet.getCell('G2').value).toContain('SSD: 512 GB')
    expect(worksheet.getCell('A2').value).toBe('Servidor')
  })
})
