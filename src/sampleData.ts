import { saveComputer, saveSession } from './db'
import type { ComputerRecord, InventorySession } from './types'
import { normalizeKey, uid } from './utils'

export async function createExampleData(ownerId?: string, ownerName = '', ownerEmail = '') {
  const stamp = new Date().toISOString()
  const session: InventorySession = {
    id: uid(),
    name: 'EJEMPLO — Inventario laboratorio 1',
    date: new Date().toISOString().slice(0, 10),
    location: 'Edificio de ejemplo, laboratorio 1',
    isExample: true,
    ownerId,
    ownerName,
    ownerEmail,
    syncStatus: 'local',
    createdAt: stamp,
    updatedAt: stamp
  }
  const computer: ComputerRecord = {
    id: uid(),
    sessionId: session.id,
    inventoryId: 'EJEMPLO-PC-001',
    equipmentType: 'Laptop',
    inventoryNormalized: normalizeKey('EJEMPLO-PC-001'),
    serialNumber: 'SN-EJEMPLO-001',
    serialNormalized: normalizeKey('SN-EJEMPLO-001'),
    brand: 'Marca de ejemplo',
    model: 'Modelo de ejemplo',
    manufacturingYear: null,
    yearUnknown: true,
    operatingSystem: 'Sin confirmar',
    ramGB: 8,
    drives: [{ id: uid(), capacityGB: 256, type: 'SSD' }],
    originalCode: 'DATO-DE-EJEMPLO-SIN-ESCANEO',
    scannedAt: stamp,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Zona local desconocida',
    latitude: null,
    longitude: null,
    accuracyMeters: null,
    writtenLocation: 'Mesa de ejemplo',
    notes: 'DATO DE EJEMPLO. Puede eliminarse sin afectar los registros reales.',
    isExample: true,
    ownerId,
    ownerName,
    ownerEmail,
    syncStatus: 'local',
    createdAt: stamp,
    updatedAt: stamp
  }
  await saveSession(session)
  await saveComputer(computer)
  return session
}
