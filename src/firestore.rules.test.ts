import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'

let environment: RulesTestEnvironment

const validSession = (ownerId: string, id: string) => ({
  id,
  cloudId: id,
  ownerId,
  ownerName: ownerId === 'alice' ? 'Alice' : 'Bob',
  ownerEmail: `${ownerId}@example.com`,
  name: 'Sesión compartida',
  date: '2026-10-09',
  location: 'Laboratorio',
  createdAt: '2026-10-09T12:00:00.000Z',
  updatedAt: '2026-10-09T12:00:00.000Z'
})

const validComputer = (ownerId: string, id: string) => ({
  id,
  cloudId: id,
  ownerId,
  ownerName: ownerId === 'alice' ? 'Alice' : 'Bob',
  ownerEmail: `${ownerId}@example.com`,
  sessionId: 'session-1',
  equipmentType: 'Laptop',
  inventoryId: 'INV-1',
  inventoryNormalized: 'INV1',
  serialNumber: 'SER-1',
  serialNormalized: 'SER1',
  brand: 'Marca',
  model: 'Modelo',
  yearUnknown: true,
  operatingSystem: 'Windows',
  drives: [],
  originalCode: '',
  scannedAt: '2026-10-09T12:00:00.000Z',
  timezone: 'America/Mazatlan',
  writtenLocation: '',
  notes: '',
  createdAt: '2026-10-09T12:00:00.000Z',
  updatedAt: '2026-10-09T12:00:00.000Z'
})

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId: 'inventario-computadoras-rules-test',
    firestore: { rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 }
  })
})

beforeEach(async () => environment.clearFirestore())
afterAll(async () => environment.cleanup())

describe('inventario compartido autenticado', () => {
  it('permite que Alice cree y que Bob vea los mismos registros', async () => {
    const alice = environment.authenticatedContext('alice').firestore()
    const bob = environment.authenticatedContext('bob').firestore()
    await assertSucceeds(setDoc(doc(alice, 'inventorySessions/session-1'), validSession('alice', 'session-1')))
    await assertSucceeds(setDoc(doc(alice, 'inventoryComputers/computer-1'), validComputer('alice', 'computer-1')))
    await assertSucceeds(getDoc(doc(bob, 'inventorySessions/session-1')))
    await assertSucceeds(getDocs(collection(bob, 'inventoryComputers')))
  })

  it('permite agregar a ambas cuentas pero solo al creador editar o eliminar', async () => {
    const alice = environment.authenticatedContext('alice').firestore()
    const bob = environment.authenticatedContext('bob').firestore()
    await assertSucceeds(setDoc(doc(alice, 'inventorySessions/session-1'), validSession('alice', 'session-1')))
    await assertSucceeds(setDoc(doc(alice, 'inventoryComputers/alice-pc'), validComputer('alice', 'alice-pc')))
    await assertSucceeds(setDoc(doc(bob, 'inventoryComputers/bob-pc'), { ...validComputer('bob', 'bob-pc'), inventoryId: 'INV-2', inventoryNormalized: 'INV2', serialNumber: 'SER-2', serialNormalized: 'SER2' }))
    await assertFails(updateDoc(doc(bob, 'inventoryComputers/alice-pc'), { model: 'Cambio ajeno' }))
    await assertFails(deleteDoc(doc(bob, 'inventoryComputers/alice-pc')))
    await assertSucceeds(updateDoc(doc(alice, 'inventoryComputers/alice-pc'), { model: 'Cambio propio' }))
    await assertSucceeds(deleteDoc(doc(alice, 'inventoryComputers/alice-pc')))
  })

  it('permite que una cuenta nueva consulte y agregue sin lista previa de correos', async () => {
    const alice = environment.authenticatedContext('alice').firestore()
    const charlie = environment.authenticatedContext('charlie', { email: 'nueva@externo.example' }).firestore()
    await assertSucceeds(setDoc(doc(alice, 'inventorySessions/session-1'), validSession('alice', 'session-1')))
    await assertSucceeds(getDocs(collection(charlie, 'inventorySessions')))
    await assertSucceeds(setDoc(doc(charlie, 'inventoryComputers/new-user-pc'), {
      ...validComputer('charlie', 'new-user-pc'),
      photoRemote: {
        fileId: 'file-1', url: 'https://ik.imagekit.io/demo/private.jpg', filePath: '/private.jpg', name: 'private.jpg',
        size: 1234, width: null, height: null, mimeType: 'image/jpeg', uploadedAt: '2026-10-09T12:00:00.000Z'
      }
    }))
  })

  it('bloquea por completo a usuarios sin sesión', async () => {
    await environment.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'inventorySessions/session-1'), validSession('alice', 'session-1'))
    })
    const guest = environment.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(guest, 'inventorySessions/session-1')))
    await assertFails(getDocs(collection(guest, 'inventorySessions')))
    await assertFails(setDoc(doc(guest, 'inventorySessions/guest-session'), validSession('guest', 'guest-session')))
  })
})
