import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from 'firebase/auth'
import { createAuthCoordinator } from './authFlow'

const auth = vi.hoisted(() => ({
  currentUser: null as unknown,
  authStateReady: vi.fn(async () => undefined),
  setPersistence: vi.fn(async (..._args: unknown[]) => undefined),
  getRedirectResult: vi.fn(async (..._args: unknown[]): Promise<{ user: unknown } | null> => null),
  signInWithPopup: vi.fn(async (..._args: unknown[]) => ({ user: {} })),
  signInWithRedirect: vi.fn(async (..._args: unknown[]) => undefined)
}))

vi.mock('firebase/app', () => ({ getApps: () => [], getApp: () => ({}), initializeApp: () => ({}) }))
vi.mock('firebase/firestore', () => ({ getFirestore: () => ({}), initializeFirestore: () => ({}), persistentLocalCache: () => ({}), persistentMultipleTabManager: () => ({}) }))
vi.mock('firebase/storage', () => ({ getStorage: () => ({}) }))
vi.mock('firebase/auth', () => ({
  getAuth: () => auth,
  browserLocalPersistence: 'local',
  indexedDBLocalPersistence: 'indexedDB',
  GoogleAuthProvider: class { setCustomParameters() { return this } },
  setPersistence: auth.setPersistence,
  getRedirectResult: auth.getRedirectResult,
  signInWithPopup: auth.signInWithPopup,
  signInWithRedirect: auth.signInWithRedirect
}))

const user = { uid: 'alice' } as User
const memoryStorage = () => {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) }
}

const loadClient = async () => {
  vi.resetModules()
  return import('./firebaseClient')
}

beforeEach(() => {
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'test-key')
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'test-project')
  vi.stubEnv('VITE_FIREBASE_APP_ID', 'test-app')
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32', maxTouchPoints: 0 })
  vi.stubGlobal('sessionStorage', memoryStorage())
  vi.stubGlobal('localStorage', memoryStorage())
  auth.currentUser = null
  for (const mock of [auth.authStateReady, auth.setPersistence, auth.getRedirectResult, auth.signInWithPopup, auth.signInWithRedirect]) mock.mockClear()
  auth.setPersistence.mockImplementation(async () => undefined)
  auth.getRedirectResult.mockImplementation(async () => null)
  auth.signInWithPopup.mockImplementation(async () => ({ user: {} }))
  auth.signInWithRedirect.mockImplementation(async () => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('inicio de sesión con Google', () => {
  it('con éxito usa la ventana emergente (también en localhost) y configura la persistencia IndexedDB primero', async () => {
    const { signInWithGoogle } = await loadClient()
    await signInWithGoogle()
    expect(auth.setPersistence).toHaveBeenCalledWith(auth, 'indexedDB')
    expect(auth.signInWithPopup).toHaveBeenCalledTimes(1)
    expect(auth.signInWithRedirect).not.toHaveBeenCalled()
  })

  it('si el popup está bloqueado usa la redirección como alternativa una sola vez', async () => {
    auth.signInWithPopup.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 'auth/popup-blocked' }))
    const { signInWithGoogle } = await loadClient()
    await signInWithGoogle()
    expect(auth.signInWithRedirect).toHaveBeenCalledTimes(1)
  })

  it('cerrar el popup muestra el error y no inicia una redirección', async () => {
    auth.signInWithPopup.mockRejectedValueOnce(Object.assign(new Error('closed'), { code: 'auth/popup-closed-by-user' }))
    const { signInWithGoogle, describeFirebaseAuthError } = await loadClient()
    const error = await signInWithGoogle().catch((caught) => caught)
    expect(describeFirebaseAuthError(error)).toContain('auth/popup-closed-by-user')
    expect(auth.signInWithRedirect).not.toHaveBeenCalled()
  })

  it('en iPhone conserva la redirección directa', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone)', platform: 'iPhone', maxTouchPoints: 5 })
    const { signInWithGoogle } = await loadClient()
    await signInWithGoogle()
    expect(auth.signInWithRedirect).toHaveBeenCalledTimes(1)
    expect(auth.signInWithPopup).not.toHaveBeenCalled()
  })

  it('la persistencia usa localStorage si IndexedDB falla y no bloquea el acceso si ambas fallan', async () => {
    auth.setPersistence.mockRejectedValueOnce(new Error('idb')).mockRejectedValueOnce(new Error('local'))
    const { signInWithGoogle } = await loadClient()
    await signInWithGoogle()
    expect(auth.setPersistence.mock.calls.map((call) => call[1])).toEqual(['indexedDB', 'local'])
    expect(auth.signInWithPopup).toHaveBeenCalled()
  })
})

describe('inicialización de la sesión', () => {
  it('getRedirectResult con usuario lo devuelve', async () => {
    auth.getRedirectResult.mockResolvedValueOnce({ user })
    const { prepareFirebaseAuth } = await loadClient()
    expect(await prepareFirebaseAuth()).toBe(user)
  })

  it('getRedirectResult null devuelve la sesión restaurada o null, tras esperar authStateReady', async () => {
    const { prepareFirebaseAuth } = await loadClient()
    expect(await prepareFirebaseAuth()).toBeNull()
    expect(auth.authStateReady).toHaveBeenCalled()
    const second = await loadClient()
    auth.currentUser = user
    expect(await second.prepareFirebaseAuth()).toBe(user)
  })

  it('un error de getRedirectResult se propaga y no queda almacenado: la siguiente llamada reintenta', async () => {
    auth.getRedirectResult.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'auth/network-request-failed' }))
    const { prepareFirebaseAuth } = await loadClient()
    await expect(prepareFirebaseAuth()).rejects.toThrow('boom')
    expect(await prepareFirebaseAuth()).toBeNull()
    expect(auth.getRedirectResult).toHaveBeenCalledTimes(2)
  })

  it('evita inicializaciones duplicadas aunque se llame varias veces', async () => {
    const { prepareFirebaseAuth } = await loadClient()
    await Promise.all([prepareFirebaseAuth(), prepareFirebaseAuth(), prepareFirebaseAuth()])
    await prepareFirebaseAuth()
    expect(auth.getRedirectResult).toHaveBeenCalledTimes(1)
    expect(auth.setPersistence).toHaveBeenCalledTimes(1)
  })

  it('si volvió de una redirección sin usuario informa que el resultado se perdió, sin reintentar', async () => {
    auth.signInWithPopup.mockRejectedValueOnce(Object.assign(new Error('blocked'), { code: 'auth/popup-blocked' }))
    const first = await loadClient()
    await first.signInWithGoogle() // marca la redirección pendiente
    const second = await loadClient()
    const error = await second.prepareFirebaseAuth().catch((caught) => caught)
    expect(second.describeFirebaseAuthError(error)).toContain('auth/redirect-result-lost')
    expect(auth.signInWithRedirect).toHaveBeenCalledTimes(1)
    expect(await second.prepareFirebaseAuth()).toBeNull() // el marcador se limpió: no hay bucle
  })
})

describe('coordinador del estado inicial', () => {
  it('no muestra el estado final antes de terminar la recuperación de la sesión', () => {
    const onUser = vi.fn()
    const coordinator = createAuthCoordinator(onUser)
    coordinator.observe(null)
    expect(onUser).not.toHaveBeenCalled()
    expect(coordinator.ready).toBe(false)
    coordinator.redirectFinished(null)
    expect(onUser).toHaveBeenCalledWith(null, true)
  })

  it('un null inicial seguido de un usuario válido no pierde al usuario', () => {
    const onUser = vi.fn()
    const coordinator = createAuthCoordinator(onUser)
    coordinator.observe(null)
    coordinator.observe(user)
    coordinator.observe(null)
    coordinator.redirectFinished(null)
    expect(onUser).toHaveBeenCalledTimes(1)
    expect(onUser).toHaveBeenCalledWith(user, true)
  })

  it('el usuario de la redirección gana sobre un null observado', () => {
    const onUser = vi.fn()
    const coordinator = createAuthCoordinator(onUser)
    coordinator.redirectFinished(user)
    expect(onUser).not.toHaveBeenCalled()
    coordinator.observe(null)
    expect(onUser).toHaveBeenCalledWith(user, true)
  })

  it('después del estado inicial entrega cambios, incluido el cierre de sesión, y no duplica el inicial', () => {
    const onUser = vi.fn()
    const coordinator = createAuthCoordinator(onUser)
    coordinator.observe(user)
    coordinator.redirectFinished(null)
    coordinator.redirectFinished(null)
    coordinator.observe(null)
    expect(onUser.mock.calls).toEqual([[user, true], [null, false]])
  })
})
