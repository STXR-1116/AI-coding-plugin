import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { describe, expect, it, vi } from 'vitest'
import { TeamSkillMemoryLoop, type TeamSkillMemoryCaptureRequest } from '../src/memory-loop.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('answer')]))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('TeamSkillMemoryLoop', () => {
  it('recalls before a step and captures only direct conversation messages', async () => {
    const ctx = await harness()
    const recalls: string[] = []
    const captures: Array<{ messages: readonly { role: string; content: string }[]; key: string }> = []
    const agent = ctx.agentLoop.create(SessionId('memory-loop'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: subject => (subject === agent ? 'project-alpha' : undefined),
      recall: async (request) => {
        recalls.push(request.query)
        return {
          status: 'READY',
          items: [{ memoryId: 'm-1', content: 'item text must not be rebuilt', score: 0.9, layer: 'L1' }],
          contextText: 'Server-authoritative context',
          strategy: 'fixture',
          effectivePolicy: { topK: 5, relevanceThreshold: 0.5, tokenBudget: 500 },
        }
      },
      capture: async (request, key) => {
        captures.push({ messages: request.messages, key })
        return { status: 'PENDING', eventId: 'e-1', jobId: 'j-1', acceptedCount: request.messages.length }
      },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'How should I code?' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(recalls).toEqual(['How should I code?'])
    expect(captures).toHaveLength(1)
    expect(captures[0]?.key).toBe('dsh-memory-loop:memory-loop:1')
    expect(captures[0]?.messages).toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'How should I code?' },
        { role: 'assistant', content: 'answer' },
      ]),
    )
    expect(captures[0]?.messages.some(item => item.content.includes('Server-authoritative context'))).toBe(false)
    expect(agent.session.events.some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes('Server-authoritative context')))).toBe(true)
    loop.dispose()
  })

  it('keeps coding running when recall or capture is unavailable', async () => {
    const ctx = await harness()
    const agent = ctx.agentLoop.create(SessionId('memory-failure'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: () => 'project-alpha',
      recall: async () => {
        throw new Error('503')
      },
      capture: async () => {
        throw new Error('503')
      },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue coding' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(true)
    loop.dispose()
  })

  it('retries a capture after an explicit failed result', async () => {
    const ctx = await harness()
    const agent = ctx.agentLoop.create(SessionId('memory-capture-retry'), { provider: 'mock', model: 'mock' })
    const captureResults = [
      { status: 'failed' as const, code: 'MEMORY_SERVICE_UNAVAILABLE', message: 'down' },
      { status: 'PENDING' as const, eventId: 'e-2', jobId: 'j-2', acceptedCount: 1 },
    ]
    const capture = vi.fn(async (..._args: [TeamSkillMemoryCaptureRequest, string]) => captureResults.shift()!)
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: () => 'project-alpha',
      recall: async () => ({
        status: 'PROJECT_REQUIRED' as const,
        items: [],
        contextText: '',
        strategy: 'not-ready',
        effectivePolicy: { topK: 0, relevanceThreshold: 1, tokenBudget: 0 },
      }),
      capture,
    })
    const firstIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await firstIdle
    await agentEvents(ctx, agent).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture.mock.calls[0]?.[1]).toBe('dsh-memory-loop:memory-capture-retry:1')
    expect(capture.mock.calls[1]?.[1]).toBe('dsh-memory-loop:memory-capture-retry:1')
    loop.dispose()
  })

  it('does not inject a recall response after the project binding changes', async () => {
    const ctx = await harness()
    const agent = ctx.agentLoop.create(SessionId('memory-project-race'), { provider: 'mock', model: 'mock' })
    let currentProject = 'project-alpha'
    let recallStartedResolve: (() => void) | undefined
    const recallStarted = new Promise<void>((resolve) => {
      recallStartedResolve = resolve
    })
    let releaseRecall: (() => void) | undefined
    const recallReady = new Promise<void>((resolve) => {
      releaseRecall = resolve
    })
    const loop = new TeamSkillMemoryLoop(ctx, {
      resolveProject: () => currentProject,
      recall: async () => {
        recallStartedResolve?.()
        await recallReady
        return {
          status: 'READY',
          items: [{ memoryId: 'm-old', content: 'old project secret', score: 0.9, layer: 'L1' }],
          contextText: 'old project secret',
          strategy: 'fixture',
          effectivePolicy: { topK: 5, relevanceThreshold: 0.5, tokenBudget: 500 },
        }
      },
      capture: async () => ({ status: 'PENDING', eventId: 'e-1', jobId: 'j-1', acceptedCount: 1 }),
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'race' }], source: { kind: 'user' } }))
    await recallStarted
    currentProject = 'project-beta'
    releaseRecall?.()
    await waitForIdle(ctx, agent)
    expect(agent.session.events.some(event => event.type === 'user/message' && event.data.content.some(block => block.type === 'text' && block.text.includes('old project secret')))).toBe(false)
    loop.dispose()
  })
})
