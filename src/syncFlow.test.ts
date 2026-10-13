import { describe, expect, it } from 'vitest'
import { advance, initialFlow, type FlowAction, type FlowState, type FlowStep } from './syncFlow'
import { defaultDecisions } from './syncPlan'

const steps: FlowStep[] = ['overview', 'comparing', 'proposal', 'confirm', 'running', 'result']
const actions: FlowAction[] = [
  { type: 'sync-now' }, { type: 'review-differences' }, { type: 'compared' }, { type: 'decide', decisions: { ...defaultDecisions(), uploadMyChanges: false } },
  { type: 'proceed' }, { type: 'back' }, { type: 'confirm' }, { type: 'finished' }
]
const at = (step: FlowStep): FlowState => ({ ...initialFlow(), step })

describe('flujo Sincronizar → Revisar → Elegir → Confirmar → Resultado', () => {
  it('la única combinación que produce el efecto de escritura es «confirm» desde el paso de confirmación', () => {
    const writers: string[] = []
    for (const step of steps) for (const action of actions) if (advance(at(step), action).effect === 'run') writers.push(`${step}:${action.type}`)
    expect(writers).toEqual(['confirm:confirm'])
  })

  it('«Sincronizar ahora» y «Revisar diferencias» siempre empiezan con una comparación de solo lectura, nunca con una escritura', () => {
    for (const type of ['sync-now', 'review-differences'] as const) {
      const result = advance(initialFlow(), { type })
      expect(result.effect).toBe('compare')
      expect(result.state.step).toBe('comparing')
    }
    expect(advance(initialFlow(), { type: 'review-differences' }).state.focusDifferences).toBe(true)
    expect(advance(initialFlow(), { type: 'sync-now' }).state.focusDifferences).toBe(false)
  })

  it('el orden es estricto: no se puede confirmar sin comparar, elegir y revisar', () => {
    let state = initialFlow()
    expect(advance(state, { type: 'confirm' }).effect).toBe('none')
    expect(advance(state, { type: 'proceed' }).state.step).toBe('overview')
    state = advance(state, { type: 'sync-now' }).state
    expect(advance(state, { type: 'confirm' }).effect).toBe('none')
    expect(advance(state, { type: 'proceed' }).state.step).toBe('comparing')
    state = advance(state, { type: 'compared' }).state
    expect(state.step).toBe('proposal')
    expect(advance(state, { type: 'confirm' }).effect).toBe('none') // aún no se ha revisado ni confirmado
    state = advance(state, { type: 'proceed' }).state
    expect(state.step).toBe('confirm')
    const run = advance(state, { type: 'confirm' })
    expect(run).toMatchObject({ effect: 'run', state: { step: 'running' } })
    expect(advance(run.state, { type: 'confirm' }).effect).toBe('none') // un segundo clic no repite la escritura
    expect(advance(run.state, { type: 'finished' }).state.step).toBe('result')
  })

  it('cambiar una decisión durante la confirmación obliga a revisar y confirmar de nuevo', () => {
    const decisions = { ...defaultDecisions(), remoteOnly: 'skip' as const }
    const result = advance(at('confirm'), { type: 'decide', decisions })
    expect(result.state.step).toBe('proposal')
    expect(result.state.decisions.remoteOnly).toBe('skip')
    expect(result.effect).toBe('none')
    expect(advance(at('overview'), { type: 'decide', decisions }).state.decisions.remoteOnly).toBe('download') // fuera de la propuesta no cambia nada
  })

  it('«Volver» nunca ejecuta nada y desde el resultado se puede sincronizar de nuevo con una comparación nueva', () => {
    for (const step of steps) expect(advance(at(step), { type: 'back' }).effect).toBe('none')
    expect(advance(at('confirm'), { type: 'back' }).state.step).toBe('proposal')
    expect(advance(at('result'), { type: 'back' }).state.step).toBe('overview')
    expect(advance(at('result'), { type: 'sync-now' })).toMatchObject({ effect: 'compare', state: { step: 'comparing' } })
  })

  it('mientras se compara o se ejecuta, las acciones de navegación no hacen nada', () => {
    for (const step of ['comparing', 'running'] as const) {
      for (const type of ['sync-now', 'review-differences', 'proceed', 'back'] as const) {
        const result = advance(at(step), { type } as FlowAction)
        expect(result.state.step).toBe(step)
        expect(result.effect).toBe('none')
      }
    }
  })
})
