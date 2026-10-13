import { defaultDecisions, type SyncDecisions } from './syncPlan'

/** Con qué decisiones empieza la revisión: todo, solo subir mis cambios o solo descargar datos. */
export type FlowMode = 'all' | 'upload' | 'download'

export const decisionsForMode = (mode: FlowMode, current: SyncDecisions): SyncDecisions =>
  mode === 'upload' ? { ...current, uploadMyChanges: true, localOnly: 'prepare', remoteOnly: 'skip', uploadPhotos: true }
    : mode === 'download' ? { ...current, uploadMyChanges: false, localOnly: 'keep', remoteOnly: 'download', uploadPhotos: false }
      : current

/**
 * Flujo: Sincronizar → Revisar diferencias → Elegir qué hacer → Confirmar → Ver resultado.
 * Es una máquina de estados pura: la única forma de obtener el efecto `run` (escribir) es confirmar desde el paso «confirm».
 */
export type FlowStep = 'overview' | 'comparing' | 'proposal' | 'confirm' | 'running' | 'result'
export type FlowEffect = 'none' | 'compare' | 'run'

export interface FlowState {
  step: FlowStep
  /** «Revisar diferencias»: abre directamente la lista de diferencias. */
  focusDifferences: boolean
  decisions: SyncDecisions
}

export type FlowAction =
  | { type: 'sync-now'; mode?: FlowMode }
  | { type: 'review-differences' }
  | { type: 'compared' }
  | { type: 'decide'; decisions: SyncDecisions }
  | { type: 'proceed' }
  | { type: 'back' }
  | { type: 'confirm' }
  | { type: 'finished' }

export const initialFlow = (): FlowState => ({ step: 'overview', focusDifferences: false, decisions: defaultDecisions() })

const same = (state: FlowState): { state: FlowState; effect: FlowEffect } => ({ state, effect: 'none' })

export function advance(state: FlowState, action: FlowAction): { state: FlowState; effect: FlowEffect } {
  switch (action.type) {
    case 'sync-now':
    case 'review-differences':
      // Siempre empieza con una comparación de solo lectura.
      if (state.step !== 'overview' && state.step !== 'result') return same(state)
      return {
        state: { ...state, step: 'comparing', focusDifferences: action.type === 'review-differences', decisions: action.type === 'sync-now' && action.mode ? decisionsForMode(action.mode, state.decisions) : state.decisions },
        effect: 'compare'
      }
    case 'compared':
      return state.step === 'comparing' ? same({ ...state, step: 'proposal' }) : same(state)
    case 'decide':
      // Cambiar una decisión nunca ejecuta nada; si ya se estaba confirmando, hay que volver a confirmar.
      return state.step === 'proposal' || state.step === 'confirm' ? same({ ...state, step: 'proposal', decisions: action.decisions }) : same(state)
    case 'proceed':
      return state.step === 'proposal' ? same({ ...state, step: 'confirm' }) : same(state)
    case 'back':
      if (state.step === 'confirm') return same({ ...state, step: 'proposal' })
      if (state.step === 'proposal' || state.step === 'result') return same({ ...state, step: 'overview', focusDifferences: false })
      return same(state)
    case 'confirm':
      // La única transición con efecto de escritura: solo desde «confirm».
      return state.step === 'confirm' ? { state: { ...state, step: 'running' }, effect: 'run' } : same(state)
    case 'finished':
      return state.step === 'running' ? same({ ...state, step: 'result' }) : same(state)
  }
}
