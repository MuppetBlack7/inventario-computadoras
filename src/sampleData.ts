import { saveComputer, saveSession } from './db'
import type { ComputerRecord, InventorySession } from './types'
import { normalizeKey, uid } from './utils'

export const TEST_QR_DATA = JSON.stringify({
  inventario: 'QR-DEMO-001',
  serie: 'SN-DEMO-2026-001',
  marca: 'Equipo de prueba',
  modelo: 'Modelo demostración',
  año: 'Desconocido',
  ubicacion: 'Laboratorio de prueba',
  observaciones: 'Registro generado con el QR de prueba; completar especificaciones manualmente.'
})

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
    originalCode: TEST_QR_DATA,
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
