import type { User } from 'firebase/auth'

/**
 * Decide cuándo se conoce el estado inicial de la sesión: solo después de que Firebase informó su primer estado
 * y terminó el resultado de la redirección. Un `null` inicial no reemplaza a un usuario recuperado después.
 * Tras el estado inicial, cada cambio (incluido el cierre de sesión) se entrega tal cual.
 */
export function createAuthCoordinator(onUser: (user: User | null, initial: boolean) => void) {
  let applied = false
  let observed = false
  let redirectDone = false
  let user: User | null = null
  const tryApply = () => {
    if (applied || !observed || !redirectDone) return
    applied = true
    onUser(user, true)
  }
  return {
    observe(next: User | null) {
      if (applied) { onUser(next, false); return }
      observed = true
      if (next || !user) user = next
      tryApply()
    },
    redirectFinished(redirectUser?: User | null) {
      if (redirectUser) user = redirectUser
      redirectDone = true
      tryApply()
    },
    get ready() { return applied }
  }
}
