import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it } from 'vitest'
import { TeamSkillGateway } from '../src/gateway.ts'

describe('TeamSkillGateway', () => {
  it('exports the browser Team Skill operations under one typed Remote namespace', () => {
    const gateway = new TeamSkillGateway(new Context(), {
      stateDirectory: 'C:/dsh/ai-coding-platform',
      globalSkillRoot: 'C:/dsh/skills',
    })

    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'teamSkills',
      namespace: 'teamSkills',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'login', invocation: { kind: 'direct' } },
      { method: 'account', invocation: { kind: 'direct' } },
      { method: 'refreshAccount', invocation: { kind: 'direct' } },
      { method: 'changePassword', invocation: { kind: 'direct' } },
      { method: 'logout', invocation: { kind: 'direct' } },
      { method: 'accessSummary', invocation: { kind: 'direct' } },
      { method: 'projects', invocation: { kind: 'direct' } },
      { method: 'project', invocation: { kind: 'direct' } },
      { method: 'catalog', invocation: { kind: 'direct' } },
      { method: 'installations', invocation: { kind: 'direct' } },
      { method: 'syncReleaseStatus', invocation: { kind: 'direct' } },
      { method: 'install', exportName: 'installSkill', invocation: { kind: 'direct' } },
      { method: 'uninstall', exportName: 'uninstallSkill', invocation: { kind: 'direct' } },
    ])
  })
})
