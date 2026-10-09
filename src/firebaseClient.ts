import { getApp, getApps, initializeApp, type FirebaseOptions } from 'firebase/app'
import {
  browserLocalPersistence,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  initializeAuth,
  indexedDBLocalPersistence,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
  type User
} from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'
import { isAppleMobilePlatform } from './authPlatform'

const config: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN_OVERRIDE || import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
}

export const firebaseConfigured = Boolean(config.apiKey && config.projectId && config.appId)
export const firebaseProjectId = config.projectId || ''
export const storageEnabled = import.meta.env.VITE_FIREBASE_STORAGE_ENABLED === 'true'

const app = firebaseConfigured ? (getApps().length ? getApp() : initializeApp(config)) : null
// The same-origin Vercel proxy is required for redirect persistence on Safari.
// Supplying both persistence providers lets Firebase fall back when IndexedDB is unavailable.
export const firebaseAuth = app
  ? initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] })
  : null
export const firestore = app ? getFirestore(app) : null
export const firebaseStorage = app && storageEnabled ? getStorage(app) : null

let persistencePromise: Promise<void> | undefined
let redirectResultPromise: Promise<User | null> | undefined

export function describeFirebaseAuthError(error: unknown) {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
  const details = error instanceof Error ? error.message : 'Firebase no proporcionó detalles adicionales.'
  const messages: Record<string, string> = {
    'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase Authentication.',
    'auth/operation-not-allowed': 'El acceso con Google no está habilitado en Firebase Authentication.',
    'auth/operation-not-supported-in-this-environment': 'Este navegador no puede abrir el flujo de acceso configurado.',
    'auth/account-exists-with-different-credential': 'Esta cuenta ya usa otro método de acceso.',
    'auth/popup-blocked': 'El navegador bloqueó la ventana de acceso.',
    'auth/network-request-failed': 'No fue posible comunicarse con Firebase. Revisa la conexión.'
  }
  const summary = messages[code] || details
  return code ? `${code}: ${summary}` : summary
}

async function configureAuthPersistence() {
  if (!firebaseAuth) return
  if (!persistencePromise) {
    persistencePromise = setPersistence(firebaseAuth, indexedDBLocalPersistence)
      .catch(() => setPersistence(firebaseAuth!, browserLocalPersistence))
  }
  await persistencePromise
}

export async function prepareFirebaseAuth() {
  if (!firebaseAuth) return null
  await configureAuthPersistence()
  if (!redirectResultPromise) {
    redirectResultPromise = getRedirectResult(firebaseAuth).then((result) => result?.user || firebaseAuth.currentUser || null)
  }
  await redirectResultPromise
  return redirectResultPromise
}

export async function signInWithGoogle() {
  if (!firebaseAuth) throw new Error('Firebase aún no está configurado')
  await configureAuthPersistence()
  const provider = new GoogleAuthProvider()
  provider.setCustomParameters({ prompt: 'select_account' })
  const isIOS = isAppleMobilePlatform(navigator)
  if (isIOS) {
    await signInWithRedirect(firebaseAuth, provider)
    return
  }
  try {
    await signInWithPopup(firebaseAuth, provider)
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
    if (['auth/popup-blocked', 'auth/cancelled-popup-request', 'auth/operation-not-supported-in-this-environment'].includes(code)) {
      await signInWithRedirect(firebaseAuth, provider)
      return
    }
    throw error
  }
}
