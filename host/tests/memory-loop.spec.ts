import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { describe, expect, it } from 'vitest'
import { TeamSkillMemoryLoop } from '../src/memory-loop.ts'
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
          items: [{ memoryId: 'm-1', content: 'Use strict checks', score: 0.9, layer: 'L1' }],
          contextText: 'Use strict checks',
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
    expect(captures[0]?.messages.some(item => item.content.includes('Use strict checks'))).toBe(false)
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
})
