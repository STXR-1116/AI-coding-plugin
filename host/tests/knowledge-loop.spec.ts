import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { describe, expect, it } from 'vitest'
import { TeamSkillKnowledgeLoop } from '../src/knowledge-loop.ts'
import type { TeamSkillKnowledgeSearchResponse } from '../src/types.ts'
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
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

function ask(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

const usedResponse: TeamSkillKnowledgeSearchResponse = {
  requestId: 'req-1',
  results: [{ knowledgeBaseId: 'k-1', knowledgeId: 'doc-1', title: '发布流程', snippet: '先提交审核', score: 0.9, sourceUrl: '/preview/doc-1', citation: { page: 1 } }],
  knowledgeBases: [{ knowledgeBaseId: 'k-1', status: 'used', reason: null }],
}

describe('TeamSkillKnowledgeLoop', () => {
  it('retrieves each user turn, records a knowledge-search event, and injects cited context', async () => {
    const ctx = await harness()
    const calls: Array<{ query: string; signal: AbortSignal }> = []
    const agent = ctx.agentLoop.create(SessionId('knowledge-loop'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: subject => subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] } : undefined,
      search: async (request, signal) => { calls.push({ query: request.query, signal }); return { status: 'ready', response: usedResponse } },
    })

    ask(agent, '如何发布？')
    await waitForIdle(ctx, agent)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.query).toBe('如何发布？')
    expect(agent.session.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'knowledge-search', data: expect.objectContaining({ requestId: 'req-1', knowledgeBaseIds: ['k-1'] }) }),
      expect.objectContaining({ type: 'user/message', data: expect.objectContaining({ source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-ai-coding-platform', form: 'recall' } }) }),
    ]))
    loop.dispose()
  })

  it('rejects the model request when every selected knowledge base is skipped', async () => {
    const skipped: TeamSkillKnowledgeSearchResponse = {
      requestId: 'req-2', results: [],
      knowledgeBases: [{ knowledgeBaseId: 'k-1', status: 'skipped', reason: 'unavailable' }],
    }
    const ctx = await harness()
    let modelRequests = 0
    ctx.llm.stream = (async function* () { modelRequests += 1 }) as never
    const agent = ctx.agentLoop.create(SessionId('knowledge-block'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: subject => subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] } : undefined,
      search: async () => ({ status: 'ready', response: skipped }),
    })

    ask(agent, '不可用资料')
    await waitForIdle(ctx, agent)

    expect(modelRequests).toBe(0)
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({ data: { reason: { kind: 'blocked' } } })
    loop.dispose()
  })

  it('passes the turn abort signal to the search and does not retain an aborted response', async () => {
    const ctx = await harness()
    const started = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<never>()
    const agent = ctx.agentLoop.create(SessionId('knowledge-abort'), { provider: 'mock', model: 'mock' })
    const loop = new TeamSkillKnowledgeLoop(ctx, {
      resolveSelection: subject => subject === agent ? { projectId: 'project-alpha', knowledgeBaseIds: ['k-1'] } : undefined,
      search: async (_request, signal) => { started.resolve(signal); return release.promise },
    })

    ask(agent, '等待检索')
    const signal = await started.promise
    agent.cancel({ kind: 'user' })

    expect(signal.aborted).toBe(true)
    release.reject(signal.reason)
    await agent.whenIdle()
    expect(agent.session.events.some(event => event.type === 'knowledge-search')).toBe(false)
    loop.dispose()
  })
})
