import type { EngineInterface } from 'claude-code'

import type { CheckOutcome, CheckRun, VibeSnapshot } from '../types'

// vibe 연동: 프로젝트의 vibe 상태를 보여주고, 버튼 하나로 검증(vibe check --all)을 돌린다.
// 엔진($)을 쓰는 일은 register.tsx가 하고, 여기는 읽기·판정·그리기만 한다.

type Elements = ReturnType<EngineInterface['ui']['resolve']>

const VIBE_COMMAND = /\bvibe\b|dist\/cli\.js/
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_ROWS = 12

const firstLine = (value: unknown) =>
  typeof value === 'string' ? (value.trim().split('\n').pop() ?? '').trim() : ''

const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 100) / 10)}초`

const count = (now: VibeSnapshot, last: string) => now.scenarios.filter(one => one.last === last).length

/** `vibe state --json` 출력을 읽는다. vibe가 추적하지 않는 폴더(state NONE)면 null */
export function summarize(text: string): VibeSnapshot | null {
  const report = JSON.parse(text) as Record<string, unknown>
  if (typeof report.state !== 'string' || report.state === 'NONE') return null

  const scenarios = Array.isArray(report.scenarios) ? (report.scenarios as Record<string, unknown>[]) : []
  const inbox = report.inbox as { open?: unknown } | undefined

  return {
    state: report.state,
    stage: typeof report.stage === 'string' ? report.stage : '',
    next: typeof report.next === 'string' ? report.next : '',
    scenarios: scenarios.map(one => ({ id: String(one.id), last: String(one.last ?? '') })),
    inboxOpen: typeof inbox?.open === 'number' ? inbox.open : 0,
  }
}

/** `vibe check --all --json` 출력을 읽는다. 동의가 없을 때처럼 검사를 못 돌렸으면 blocked */
export function parseCheck(text: string, startedAt: number, endedAt: number): CheckRun {
  const base = { startedAt, endedAt, passed: 0, failed: 0, outcomes: [] as CheckOutcome[] }
  const report = JSON.parse(text) as Record<string, unknown>
  if (typeof report.error === 'string') return { ...base, status: 'blocked', message: report.error }

  const list = Array.isArray(report.outcomes) ? (report.outcomes as Record<string, unknown>[]) : []
  const outcomes = list.map(one => ({
    id: String(one.id),
    status: String(one.status ?? ''),
    ms: typeof one.ms === 'number' ? one.ms : 0,
    reason: firstLine(one.reason) || firstLine(one.tail),
  }))

  return {
    ...base,
    status: 'done',
    passed: typeof report.passed === 'number' ? report.passed : outcomes.filter(o => o.status === 'pass').length,
    failed: typeof report.failed === 'number' ? report.failed : outcomes.filter(o => o.status === 'fail').length,
    outcomes,
    message: '',
  }
}

export const checkLine = (run: CheckRun): string =>
  run.status === 'running'
    ? '⟳ 검사 중…'
    : run.status === 'blocked'
      ? `⊘ 검사 못 함: ${run.message}`
      : `${run.failed > 0 ? '✗' : '✓'} 검사 통과 ${run.passed} · 실패 ${run.failed} · ${seconds((run.endedAt ?? run.startedAt) - run.startedAt)}`

/** 통과였다가 방금 stale로 바뀐 시나리오 */
export const turnedStale = (before: VibeSnapshot | null, found: VibeSnapshot | null): string[] => {
  if (before === null || found === null) return []
  const passed = new Set(before.scenarios.filter(one => one.last === 'pass').map(one => one.id))

  return found.scenarios.filter(one => one.last === 'stale' && passed.has(one.id)).map(one => one.id)
}

export const blockedRun = (startedAt: number, endedAt: number): CheckRun => ({
  status: 'blocked',
  startedAt,
  endedAt,
  passed: 0,
  failed: 0,
  outcomes: [],
  message: '검사를 끝내지 못했어요 (10분을 넘겼거나 vibe 명령을 실행할 수 없어요)',
})

/** 파일을 고쳤거나 vibe 명령을 돌린 도구 호출 뒤에만 다시 읽는다. */
export const touchesVibe = (tool: string, args: Record<string, unknown>) =>
  EDIT_TOOLS.has(tool) ||
  ((tool === 'Bash' || tool === 'PowerShell') && VIBE_COMMAND.test(String(args.command ?? '')))

type BandActions = { onCheck: () => void; onHide: () => void }

/** 입력창 위 vibe 줄 */
export function vibeBand({ Box, Button, Text }: Elements, now: VibeSnapshot, run: CheckRun | null, actions: BandActions) {
  const total = now.scenarios.length
  const pass = count(now, 'pass')
  const failing = now.scenarios.filter(one => one.last === 'fail').map(one => one.id)
  const stale = count(now, 'stale')

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>vibe {now.state} </Text>
        {now.stage !== '' && <Text dimColor>· {now.stage} </Text>}
        <Text color={total > 0 && pass === total ? 'success' : undefined}>
          · {pass}/{total} pass{' '}
        </Text>
        {failing.length > 0 && (
          <Text color="error">
            · {failing.length} fail ({failing.slice(0, 3).join(', ')}
            {failing.length > 3 ? ', …' : ''}){' '}
          </Text>
        )}
        {stale > 0 && <Text color="warning">· {stale} stale </Text>}
        {now.inboxOpen > 0 && <Text color="warning">· 질문 {now.inboxOpen} </Text>}
        {run?.status === 'running' ? (
          <Text color="warning">⟳ 검사 중… </Text>
        ) : (
          <Button key="vibe-check" label="검사" onPress={actions.onCheck} />
        )}
        <Text> </Text>
        <Button key="vibe-hide" label="숨기기" onPress={actions.onHide} />
      </Box>
      {now.next !== '' && (
        <Text dimColor wrap="truncate-end">
          다음: {now.next}
        </Text>
      )}
    </Box>
  )
}

const LAST_MARK: Record<string, string> = { pass: '✓', fail: '✗', handoff: '?' }
const LAST_COLOR: Record<string, string> = { pass: 'success', fail: 'error', handoff: 'warning' }

/** 패널의 vibe 구역과 그 줄 수. 마지막 검사 결과가 있으면 그것을, 없으면 기록된 상태를 보여준다. */
export function vibeSection({ Box, Text }: Elements, now: VibeSnapshot, run: CheckRun | null) {
  const rows: CheckOutcome[] =
    run !== null && run.status === 'done'
      ? run.outcomes
      : now.scenarios.map(one => ({ id: one.id, status: one.last, ms: 0, reason: '' }))
  // 실패를 먼저 보여준다
  const sorted = [...rows.filter(one => one.status === 'fail'), ...rows.filter(one => one.status !== 'fail')]
  const shown = sorted.slice(0, MAX_ROWS)
  const hidden = sorted.length - shown.length

  const tree = (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        vibe {now.state}
        {now.stage !== '' ? ` · ${now.stage}` : ''}
      </Text>
      {now.next !== '' && (
        <Text dimColor wrap="truncate-end">
          다음: {now.next}
        </Text>
      )}
      {run !== null && (
        <Text
          color={run.status === 'running' ? 'warning' : run.status === 'done' && run.failed === 0 ? 'success' : 'error'}
          wrap="truncate-end"
        >
          {checkLine(run)}
        </Text>
      )}
      {shown.map(one => (
        <Text key={one.id} wrap="truncate-end" dimColor={one.status === 'pass'}>
          <Text color={LAST_COLOR[one.status] ?? 'subtle'}>{LAST_MARK[one.status] ?? '○'}</Text> {one.id}
          {one.ms > 0 ? ` ${seconds(one.ms)}` : ''}
          {one.status !== 'pass' && one.status !== 'fail' && one.reason === '' ? ` (${one.status})` : ''}
          {one.reason !== '' ? ` — ${one.reason}` : ''}
        </Text>
      ))}
      {hidden > 0 && <Text dimColor>… 외 {hidden}개</Text>}
    </Box>
  )

  return { tree, rows: 3 + (now.next !== '' ? 1 : 0) + (run !== null ? 1 : 0) + shown.length + (hidden > 0 ? 1 : 0) }
}
