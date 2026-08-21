/**
 * Unit coverage for the browser half: URL building against the serving
 * origin, cwd resolution from the sessions snapshot, and the apply-time
 * registration path with fake services plus a stubbed `window` — no test
 * opens a real tab. Pick outcomes assert both branches: the successful open
 * clears the draft token, the popup-blocked open leaves the URL to copy.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { appUrl, apply, currentCwd, openTab } from '../src/client.ts'

/** Minimal sessions face answering one frozen snapshot. */
function sessionsWith(snapshot: unknown): { list: { getSnapshot(): unknown } } {
  return { list: { getSnapshot: () => snapshot } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('currentCwd', () => {
  it('resolves the current session cwd from the snapshot', () => {
    const sessions = sessionsWith({
      current: 's1',
      byId: { s1: { cwd: '/home/dsh/project' } },
    })
    expect(currentCwd(sessions as never)).toBe('/home/dsh/project')
  })

  it('returns undefined without a current session', () => {
    const sessions = sessionsWith({ current: undefined, byId: {} })
    expect(currentCwd(sessions as never)).toBeUndefined()
  })

  it('returns undefined when the store throws', () => {
    const sessions = { list: { getSnapshot: () => { throw new Error('store down') } } }
    expect(currentCwd(sessions as never)).toBeUndefined()
  })
})

describe('appUrl', () => {
  it('deep-links to the cwd against the serving origin', () => {
    vi.stubGlobal('window', { location: { origin: 'https://dsh.example.com' } })
    expect(appUrl('/home/dsh/project')).toBe(
      'https://dsh.example.com/dsh-agfs/?path=%2Fhome%2Fdsh%2Fproject',
    )
  })

  it('falls back to the bare base without a cwd', () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3080' } })
    expect(appUrl(undefined)).toBe('http://127.0.0.1:3080/dsh-agfs/')
    expect(appUrl('')).toBe('http://127.0.0.1:3080/dsh-agfs/')
  })
})

describe('openTab', () => {
  it('reports success when window.open returns a window', () => {
    const open = vi.fn(() => ({}) as unknown)
    vi.stubGlobal('window', { open })
    expect(openTab('https://dsh.example.com/dsh-agfs/')).toBe(true)
    expect(open).toHaveBeenCalledWith('https://dsh.example.com/dsh-agfs/', '_blank', 'noopener')
  })

  it('reports failure for a popup-blocked null return', () => {
    vi.stubGlobal('window', { open: () => null })
    expect(openTab('https://dsh.example.com/dsh-agfs/')).toBe(false)
  })
})

describe('apply', () => {
  /** Fake ctx capturing the effect registration and the registered source. */
  function fakeCtx(sessions: unknown) {
    const registered: unknown[] = []
    const disposers: Array<() => void> = []
    return {
      registered,
      get: (service: string) =>
        service === 'sessions'
          ? sessions
          : { registerSource: (source: unknown) => { registered.push(source); return () => registered.splice(0) } },
      effect: (register: () => () => void) => { disposers.push(register()) },
      disposers,
    }
  }

  it('registers one slash source named dsh-agfs exposing the files candidate', async () => {
    const ctx = fakeCtx(sessionsWith({ current: 's1', byId: { s1: { cwd: '/w' } } }))
    apply(ctx as never)
    expect(ctx.registered).toHaveLength(1)
    const source = ctx.registered[0] as { trigger: string; name: string; candidates: () => Promise<Array<{ name: string }>> }
    expect(source.trigger).toBe('/')
    expect(source.name).toBe('dsh-agfs')
    const candidates = await source.candidates()
    expect(candidates.map((c) => c.name)).toEqual(['files'])
  })

  it('clears the token span on a successful open', () => {
    vi.stubGlobal('window', { location: { origin: 'https://dsh.example.com' }, open: () => ({}) as unknown })
    const ctx = fakeCtx(sessionsWith({ current: 's1', byId: { s1: { cwd: '/w' } } }))
    apply(ctx as never)
    const source = ctx.registered[0] as { onPick: () => { text: string } }
    expect(source.onPick()).toEqual({ text: '' })
  })

  it('leaves the URL in the draft when the popup is blocked', () => {
    vi.stubGlobal('window', { location: { origin: 'https://dsh.example.com' }, open: () => null })
    const ctx = fakeCtx(sessionsWith({ current: 's1', byId: { s1: { cwd: '/w' } } }))
    apply(ctx as never)
    const source = ctx.registered[0] as { onPick: () => { text: string } }
    expect(source.onPick()).toEqual({ text: 'https://dsh.example.com/dsh-agfs/?path=%2Fw' })
  })
})
