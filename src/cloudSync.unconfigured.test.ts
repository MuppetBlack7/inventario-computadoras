import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./firebaseClient', () => ({ firestore: null }))
vi.mock('./imageKitClient', () => ({
  imageKitConfigured: false,
  uploadPhotoToImageKit: vi.fn(),
  cleanupReplacedImageKitPhoto: vi.fn(),
  deleteCurrentImageKitPhoto: vi.fn()
}))

import { clearAllData, getPendingSyncQueue, saveComputer } from './db'
import { synchronize } from './cloudSync'
import type { ComputerRecord } from './types'

const computer: ComputerRecord = {
  id: 'offline-no-firebase', sessionId: 'session', inventoryId: 'INV-OFF', inventoryNormalized: 'INVOFF',
  equipmentType: 'Laptop', serialNumber: 'SN-OFF', serialNormalized: 'SNOFF', brand: 'Marca', model: 'Modelo',
  manufacturingYear: null, yearUnknown: true, operatingSystem: 'Linux', ramGB: 8, drives: [], originalCode: '',
  scannedAt: '2026-10-12T12:00:00.000Z', timezone: 'America/Mazatlan', latitude: null, longitude: null,
  accuracyMeters: null, writtenLocation: '', notes: '', ownerId: 'alice', syncStatus: 'local',
  createdAt: '2026-10-12T12:00:00.000Z', updatedAt: '2026-10-12T12:00:00.000Z'
}

beforeEach(async () => {
  vi.stubGlobal('navigator', { onLine: true })
  await clearAllData()
})

describe('sincronización sin Firebase disponible', () => {
  it('rechaza la sincronización y conserva intacta la operación pendiente', async () => {
    await saveComputer(computer)
    await expect(synchronize('alice')).rejects.toThrow('Firebase no está configurado')
    expect(await getPendingSyncQueue()).toHaveLength(1)
  })
})
