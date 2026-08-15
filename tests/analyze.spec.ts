/**
 * Unit coverage for the one-click AI analysis orchestration: workspace
 * creation, session minting, and the waking follow-up message. The workspace
 * and agent services are stubbed via ctx.provide; the real Loader composition
 * exercises the HTTP endpoint's validation and missing-service error paths in
 * composition.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { runAnalysis } from '../src/index.ts'

describe('runAnalysis', () => {
  it('creates the workspace, mints a session, and wakes the agent with the requirement', async () => {
    const ctx = new Context()
    const createWorkspace = vi.fn(async () => ({}))
    ctx.provide('workspaceRegistry', { create: createWorkspace } as never)
    const followup = vi.fn()
    const agent = { followup }
    const dispose = vi.fn(async () => undefined)
    const createAgent = vi.fn(async () => ({ agent, dispose }))
    ctx.provide('agents', { create: createAgent } as never)

    const result = await runAnalysis(ctx, 'C:\\proj', 'analyze this directory')

    expect(createWorkspace).toHaveBeenCalledWith('C:\\proj')
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ meta: { cwd: 'C:\\proj' } }))
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]?.[0] as { content: Array<{ type: string; text: string }>; source: { kind: string } }
    expect(message.content).toEqual([{ type: 'text', text: 'analyze this directory' }])
    expect(message.source).toEqual({ kind: 'user' })
    expect(result.workspacePath).toBe('C:\\proj')
    expect(result.sessionId).toMatch(/^analysis-/)
  })

  it('fails loud when the workspace service is missing', async () => {
    const ctx = new Context()
    await expect(runAnalysis(ctx, 'C:\\proj', 'x')).rejects.toThrow('工作区服务不可用')
  })

  it('fails loud when the agent service is missing', async () => {
    const ctx = new Context()
    ctx.provide('workspaceRegistry', { create: async () => ({}) } as never)
    await expect(runAnalysis(ctx, 'C:\\proj', 'x')).rejects.toThrow('智能体服务不可用')
  })
})
