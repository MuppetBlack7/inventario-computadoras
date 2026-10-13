import { getApp, getApps, initializeApp, type FirebaseOptions } from 'firebase/app'
import {
  browserLocalPersistence,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  indexedDBLocalPersistence,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  type User
} from 'firebase/auth'
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, type Firestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { isAppleMobilePlatform } from './authPlatform'

const config: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
}

export const firebaseConfigured = Boolean(config.apiKey && config.projectId && config.appId)
export const firebaseProjectId = config.projectId || ''
export const storageEnabled = import.meta.env.VITE_FIREBASE_STORAGE_ENABLED === 'true'

const app = firebaseConfigured ? (getApps().length ? getApp() : initializeApp(config)) : null
// getAuth configures Firebase's browser popup/redirect resolver and its normal
// IndexedDB/local-storage fallback. configureAuthPersistence below enforces it
// before redirect sign-in and before handling its result.
export const firebaseAuth = app ? getAuth(app) : null
// Caché persistente de Firestore (IndexedDB, varias pestañas) para lecturas offline y menos tráfico.
const createFirestore = (): Firestore | null => {
  if (!app) return null
  try {
    return initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })
  } catch {
    return getFirestore(app)
  }
}
export const firestore = createFirestore()
export const firebaseStorage = app && storageEnabled ? getStorage(app) : null

type PersistenceKind = 'indexedDB' | 'local' | 'default'
let persistencePromise: Promise<PersistenceKind> | undefined
let redirectResultPromise: Promise<User | null> | undefined

const REDIRECT_PENDING_KEY = 'inventario.auth.redirectPending'

const authDebugEnabled = () => {
  try { return import.meta.env.DEV || localStorage.getItem('inventario.authDebug') === '1' } catch { return Boolean(import.meta.env.DEV) }
}

/** Diagnóstico de autenticación: solo registra eventos y códigos de error, nunca tokens, correos ni identificadores. */
export function authLog(event: string, detail?: Record<string, unknown>) {
  if (!authDebugEnabled()) return
  console.info(`[auth] ${event}`, detail ?? '')
}

const errorSummary = (error: unknown) => ({
  code: typeof error === 'object' && error && 'code' in error ? String(error.code) : undefined,
  message: error instanceof Error ? error.message : String(error)
})

const readPendingRedirect = () => { try { return sessionStorage.getItem(REDIRECT_PENDING_KEY) === '1' } catch { return false } }
const writePendingRedirect = (value: boolean) => {
  try { if (value) sessionStorage.setItem(REDIRECT_PENDING_KEY, '1'); else sessionStorage.removeItem(REDIRECT_PENDING_KEY) } catch { /* almacenamiento bloqueado */ }
}

export function describeFirebaseAuthError(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
  const details = error instanceof Error ? error.message : 'Firebase no proporcionó detalles adicionales.'
  const messages: Record<string, string> = {
    'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase Authentication.',
    'auth/operation-not-allowed': 'El acceso con Google no está habilitado en Firebase Authentication.',
    'auth/operation-not-supported-in-this-environment': 'Este navegador no puede abrir el flujo de acceso configurado.',
    'auth/account-exists-with-different-credential': 'Esta cuenta ya usa otro método de acceso.',
    'auth/popup-blocked': 'El navegador bloqueó la ventana de acceso.',
    'auth/popup-closed-by-user': 'Se cerró la ventana de Google antes de terminar el acceso.',
    'auth/cancelled-popup-request': 'Ya hay una ventana de acceso abierta.',
    'auth/redirect-result-lost': 'Google devolvió a la aplicación pero el navegador no conservó el resultado del acceso (almacenamiento de terceros bloqueado). Inicia sesión de nuevo con la ventana emergente.',
    'auth/network-request-failed': 'No fue posible comunicarse con Firebase. Revisa la conexión.'
  }
  const summary = messages[code] || details
  return code ? `${code}: ${summary}` : summary
}

async function configureAuthPersistence(): Promise<PersistenceKind> {
  if (!firebaseAuth) return 'default'
  if (!persistencePromise) {
    const auth = firebaseAuth
    authLog('persistence:start')
    persistencePromise = setPersistence(auth, indexedDBLocalPersistence)
      .then((): PersistenceKind => 'indexedDB')
      .catch((error) => {
        authLog('persistence:indexedDB-failed', errorSummary(error))
        return setPersistence(auth, browserLocalPersistence).then((): PersistenceKind => 'local')
      })
      .catch((error): PersistenceKind => {
        // El SDK conserva su persistencia por defecto; no se bloquea el acceso ni se guarda un rechazo.
        authLog('persistence:fallback-failed', errorSummary(error))
        return 'default'
      })
      .then((kind) => { authLog('persistence:done', { kind }); return kind })
  }
  return persistencePromise
}

/**
 * Inicializa la autenticación una sola vez: persistencia, resultado de redirección y restauración de la sesión.
 * Las llamadas simultáneas comparten la misma promesa; si falla, la siguiente llamada puede reintentar.
 */
export function prepareFirebaseAuth(): Promise<User | null> {
  if (!firebaseAuth) return Promise.resolve(null)
  if (!redirectResultPromise) {
    const auth = firebaseAuth
    authLog('init:start')
    const promise = (async () => {
      await configureAuthPersistence()
      let redirectUser: User | null = null
      try {
        const result = await getRedirectResult(auth)
        redirectUser = result?.user ?? null
        authLog('redirect-result', { outcome: result?.user ? 'user' : 'null' })
      } catch (error) {
        authLog('redirect-result', { outcome: 'error', ...errorSummary(error) })
        writePendingRedirect(false)
        throw error
      }
      // Espera a que el SDK termine de restaurar la sesión guardada antes de decidir que no hay usuario.
      await auth.authStateReady?.()
      const user = redirectUser || auth.currentUser
      authLog('init:done', { user: Boolean(user) })
      if (readPendingRedirect()) {
        writePendingRedirect(false)
        if (!user) throw Object.assign(new Error('El resultado de la redirección de Google no estaba disponible.'), { code: 'auth/redirect-result-lost' })
      }
      return user
    })()
    redirectResultPromise = promise
    promise.catch(() => { if (redirectResultPromise === promise) redirectResultPromise = undefined })
  }
  return redirectResultPromise
}

const REDIRECT_FALLBACK_CODES = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment']

async function redirectToGoogle(auth: NonNullable<typeof firebaseAuth>, provider: GoogleAuthProvider) {
  writePendingRedirect(true)
  authLog('redirect:start')
  try {
    await signInWithRedirect(auth, provider)
  } catch (error) {
    writePendingRedirect(false)
    throw error
  }
}

export async function signInWithGoogle() {
  if (!firebaseAuth) throw new Error('Firebase aún no está configurado')
  await configureAuthPersistence()
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  // Safari/iOS conserva la redirección. En el resto, incluido localhost, la ventana emergente es el flujo principal:
  // en localhost el dominio de autenticación (firebaseapp.com) es de otro sitio y los navegadores modernos
  // aíslan su almacenamiento, por lo que el resultado de una redirección no llega a la aplicación.
  if (isAppleMobilePlatform(navigator)) {
    await redirectToGoogle(firebaseAuth, provider)
    return
  }
  try {
    authLog('popup:start')
    await signInWithPopup(firebaseAuth, provider)
    authLog('popup:done', { user: Boolean(firebaseAuth.currentUser) })
  } catch (error) {
    const summary = errorSummary(error)
    authLog('popup:error', summary)
    if (summary.code && REDIRECT_FALLBACK_CODES.includes(summary.code)) {
      await redirectToGoogle(firebaseAuth, provider)
      return
    }
    throw error
  }
}
