/** Host services for the AI Coding platform plugin. */

export type * from './installer.ts'
export type * from './types.ts'
export type { Config } from './gateway.ts'
export {
  TeamSkillInstallError,
  installTeamSkill,
  quarantineTeamSkill,
  uninstallTeamSkill,
} from './installer.ts'
export { TeamSkillHost } from './host.ts'
export { TeamSkillGateway } from './gateway.ts'
export { default } from './gateway.ts'
