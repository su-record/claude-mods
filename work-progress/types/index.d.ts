export type TurnStatus = 'running' | 'done' | 'aborted' | 'error'

export type Turn = {
  prompt: string
  status: TurnStatus
  startedAt: number
  endedAt?: number
}

export type PlanItem = {
  id: string
  text: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type StepStatus = 'run' | 'ok' | 'fail' | 'deny'

export type Step = {
  id: string
  tool: string
  label: string
  status: StepStatus
  isSub: boolean
  startedAt: number
  endedAt?: number
}

export type SubAgentStatus = 'run' | 'done' | 'aborted' | 'error'

export type SubAgent = {
  id: string
  type: string
  description: string
  isBackground: boolean
  status: SubAgentStatus
  startedAt: number
  endedAt?: number
  /** 이 서브에이전트가 부른 도구 수 */
  tools: number
  /** 마지막으로 부른 도구 한 줄 */
  current: string
}

export type Verdict = 'unverified' | 'failed' | 'verified'

/** 한 번의 요청(메인 턴)에서 고친 파일과 돌린 검증의 판정 */
export type Report = {
  verdict: Verdict
  /** 고친 코드 파일 경로 (문서 파일은 빠진다) */
  files: string[]
  /** 마지막 검증 명령, 없으면 빈 문자열 */
  command: string
}

declare module 'claude-code' {
  interface PluginState {
    'work-progress': {
      turn: Turn | null
      plan: PlanItem[]
      steps: Step[]
      agents: SubAgent[]
      now: number
      /** 마지막 요청의 검증 판정 */
      evidence: Report | null
      /** 입력창 위 경고 줄을 숨겼는지 */
      evidenceHidden: boolean
    }
  }
}
