import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamSkillInstallationStore } from '../src/installation-store.ts'
import type { TeamSkillInstallationRecord } from '../src/types.ts'

function record(id: string, overrides: Partial<TeamSkillInstallationRecord> = {}): TeamSkillInstallationRecord {
  return {
    localInstallationId: id,
    skillId: `skill-${id}`,
    projectId: 'project-alpha',
    scope: 'global',
    installed: {
      runtimeName: `runtime-${id}`,
      version: '1.0.0',
      artifactSha256: `sha-${id}`,
      directory: `/tmp/${id}`,
      files: [],
      state: 'normal',
    },
    installedAt: '2026-09-04T00:00:00.000Z',
    ...overrides,
  }
}

describe('TeamSkillInstallationStore', () => {
  it('serializes concurrent upserts so no installation record is lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const first = new TeamSkillInstallationStore(root)
      const second = new TeamSkillInstallationStore(root)
      await Promise.all([first.upsert(record('one')), second.upsert(record('two'))])
      await expect(first.list()).resolves.toEqual(expect.arrayContaining([record('one'), record('two')]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes concurrent remove and upsert against the same file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const first = new TeamSkillInstallationStore(root)
      const second = new TeamSkillInstallationStore(root)
      await first.upsert(record('keep'))
      await Promise.all([first.remove('keep'), second.upsert(record('new'))])
      await expect(first.list()).resolves.toEqual([record('new')])
      await expect(readFile(join(root, 'team-skill-installations.json'), 'utf8')).resolves.toContain('skill-new')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps one record per project for the same skill under the same global scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const store = new TeamSkillInstallationStore(root)
      await store.upsert(record('alpha', { skillId: 'skill-shared', projectId: 'project-alpha' }))
      await store.upsert(record('beta', { skillId: 'skill-shared', projectId: 'project-beta' }))
      const records = await store.list()
      expect(records.map(value => value.projectId).sort()).toEqual(['project-alpha', 'project-beta'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps one record per project for the same skill, scope and workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const store = new TeamSkillInstallationStore(root)
      await store.upsert(
        record('alpha', {
          skillId: 'skill-shared',
          projectId: 'project-alpha',
          scope: 'project',
          workspaceId: 'workspace-1',
        }),
      )
      await store.upsert(
        record('beta', {
          skillId: 'skill-shared',
          projectId: 'project-beta',
          scope: 'project',
          workspaceId: 'workspace-1',
        }),
      )
      const records = await store.list()
      expect(records.map(value => value.projectId).sort()).toEqual(['project-alpha', 'project-beta'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('replaces only the same project record when that project reinstalls the same scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installation-store-'))
    try {
      const store = new TeamSkillInstallationStore(root)
      await store.upsert(record('alpha-old', { skillId: 'skill-shared', projectId: 'project-alpha' }))
      await store.upsert(record('beta', { skillId: 'skill-shared', projectId: 'project-beta' }))
      await store.upsert(record('alpha-new', { skillId: 'skill-shared', projectId: 'project-alpha' }))
      const records = await store.list()
      expect(records).toHaveLength(2)
      expect(records.map(value => value.localInstallationId).sort()).toEqual(['alpha-new', 'beta'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
