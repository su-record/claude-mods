import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CheckRun, PlanItem, Step, SubAgent, Turn, VibeSnapshot } from '../types'
import { createTracker, filesLine, summary, VERDICT_COLOR, VERDICT_LABEL } from './evidence'
import { blockedRun, checkLine, parseCheck, summarize, touchesVibe, turnedStale, vibeBand, vibeSection } from './vibe'

const PANE = 'work-progress'
const TITLE = '작업 진행'
const MAX_STEPS = 300
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

const turn = atom({ plugin: 'work-progress', key: 'turn' } as const, null)
const plan = atom({ plugin: 'work-progress', key: 'plan' } as const, [])
const steps = atom({ plugin: 'work-progress', key: 'steps' } as const, [])
const agents = atom({ plugin: 'work-progress', key: 'agents' } as const, [])
const now = atom({ plugin: 'work-progress', key: 'now' } as const, 0)
const evidence = atom({ plugin: 'work-progress', key: 'evidence' } as const, null)
const evidenceHidden = atom({ plugin: 'work-progress', key: 'evidenceHidden' } as const, false)
const snapshot = atom({ plugin: 'work-progress', key: 'vibe' } as const, null)
const vibeHidden = atom({ plugin: 'work-progress', key: 'vibeHidden' } as const, false)
const check = atom({ plugin: 'work-progress', key: 'check' } as const, null)

let ticker: Timer | undefined
let latestRefresh = 0
let vibeProbe: Promise<boolean> | undefined
let autoOpened = false
const tracker = createTracker()

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const baseName = (path: unknown) =>
  typeof path === 'string' ? path.split(/[\\/]/).filter(Boolean).pop() ?? path : ''

/** 도구 호출 하나를 사람이 읽을 수 있는 한 줄로 바꾼다. */
export const describe = (tool: string, args: Record<string, unknown>): string => {
  const str = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : '')
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return oneLine(str('description') || str('command'))
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return baseName(args.file_path ?? args.notebook_path)
    case 'Grep':
    case 'Glob':
      return str('pattern')
    case 'Agent':
      return str('description')
    case 'Skill':
      return str('skill')
    case 'WebFetch':
      return str('url')
    case 'WebSearch':
      return str('query')
    case 'ToolSearch':
      return str('query')
    default:
      return ''
  }
}

/** 경과 시간을 "1분 23초" 꼴로 쓴다. */
export const elapsed = (ms: number): string => {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}초`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분 ${sec % 60}초`
  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}

const STEP_MARK: Record<Step['status'], string> = { run: '⟳', ok: '✓', fail: '✗', deny: '⊘' }
const STEP_COLOR: Record<Step['status'], string> = {
  run: 'warning',
  ok: 'success',
  fail: 'error',
  deny: 'error',
}
const PLAN_MARK: Record<PlanItem['status'], string> = { pending: '○', in_progress: '▶', completed: '✓' }
const AGENT_MARK: Record<SubAgent['status'], string> = { run: '⟳', done: '✓', aborted: '⊘', error: '✗' }
const AGENT_COLOR: Record<SubAgent['status'], string> = {
  run: 'warning',
  done: 'success',
  aborted: 'subtle',
  error: 'error',
}
const TURN_LABEL: Record<Turn['status'], string> = {
  running: '⟳ 진행 중',
  done: '✓ 완료',
  aborted: '⊘ 중단됨',
  error: '✗ 오류로 종료',
}
const TURN_COLOR: Record<Turn['status'], string> = {
  running: 'warning',
  done: 'success',
  aborted: 'subtle',
  error: 'error',
}

const statusOf = (reason: string): 'done' | 'aborted' | 'error' =>
  reason === 'answer' ? 'done' : reason === 'aborted' ? 'aborted' : 'error'

// 메인 작업이나 서브에이전트가 하나라도 돌고 있으면 경과 시간을 계속 센다
async function stopTickerIfIdle($: EngineInterface) {
  const current = await read($, turn)
  const list = await read($, agents)
  if (current?.status === 'running' || list.some(agent => agent.status === 'run')) return
  ticker?.cancel()
  ticker = undefined
}

// 메인 요청이 답으로 끝났을 때 검증을 판정하고, 미검증·실패면 알린다
async function judgeEvidence($: EngineInterface) {
  const report = tracker.report()
  if (report === null) return

  await update($, evidence, () => report)
  if (report.verdict !== 'verified') {
    $.ui.toast(
      report.verdict === 'unverified'
        ? '⚠ 코드를 고쳤는데 테스트·빌드 없이 끝났어요'
        : '✗ 마지막 검증이 실패한 채로 끝났어요',
    )
  }
}

// vibe 명령이 이 컴퓨터에 있는지 세션마다 한 번만 확인한다. 없으면 vibe 쪽은 전부 건너뛴다.
function hasVibe($: EngineInterface): Promise<boolean> {
  vibeProbe ??= $.process
    .run(['vibe', '--version'], { timeoutMs: 15_000 })
    .then(ran => ran.exitCode === 0)
    .catch(() => false)

  return vibeProbe
}

// vibe 상태를 다시 읽는다. 통과였던 시나리오가 stale로 바뀌면 알린다.
async function refresh($: EngineInterface): Promise<VibeSnapshot | null> {
  if (!(await hasVibe($))) return null

  const mine = ++latestRefresh
  let found: VibeSnapshot | null = null

  try {
    const ran = await $.process.run(['vibe', 'state', '--json'], {
      cwd: await $.session.root(),
      timeoutMs: 15_000,
    })
    found = ran.exitCode === 0 ? summarize(ran.stdout) : null
  } catch {
    found = null
  }
  // 늦게 끝난 옛 조회가 새 결과를 덮지 않게 한다
  if (mine !== latestRefresh) return found

  // 도구 호출 뒤에는 기다리지 않고 부르므로, 세션이 끝난 뒤의 실패가 밖으로 새지 않게 한다
  try {
    const turned = turnedStale(await read($, snapshot), found)
    await update($, snapshot, () => found)
    if (turned.length > 0) $.ui.toast(`방금 수정으로 다시 검사가 필요해졌어요: ${turned.join(', ')}`)
  } catch {}

  return found
}

// `vibe check --all`을 돌리고 결과를 남긴다. 이미 도는 중이면 새로 시작하지 않는다.
async function runCheck($: EngineInterface): Promise<CheckRun> {
  const current = await read($, check)
  if (current?.status === 'running') return current

  const startedAt = await $.clock.now()
  if (!(await hasVibe($))) return blockedRun(startedAt, startedAt)

  await update($, check, (): CheckRun => ({ ...blockedRun(startedAt, startedAt), status: 'running', message: '' }))

  let result: CheckRun
  try {
    const ran = await $.process.run(['vibe', 'check', '--all', '--json'], {
      cwd: await $.session.root(),
      timeoutMs: 600_000,
    })
    result = parseCheck(ran.stdout, startedAt, await $.clock.now())
  } catch {
    result = blockedRun(startedAt, await $.clock.now())
  }

  await update($, check, () => result)
  await refresh($)
  $.ui.toast(checkLine(result))

  return result
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: '작업 진행 패널(진행 중인 작업·계획·스텝)을 연다',
    })
    await $.command.register({
      name: 'evidence',
      description: '마지막 요청에서 고친 파일과 돌린 검증을 보여준다',
    })
    // 새 세션(또는 다시 불러온 mod)마다 vibe가 있는지 다시 확인한다
    vibeProbe = undefined
    if (await hasVibe($)) {
      await $.command.register({
        name: 'vibe-status',
        description: 'vibe 상태 줄을 새로 읽고 다시 보여준다',
      })
      await $.command.register({
        name: 'vibe-check',
        description: 'vibe check --all 을 돌리고 결과를 패널에 보여준다',
      })
      await refresh($)
    }

    return next(e)
  })

  // 사이드 패널(전체화면 레이아웃)일 때만 알아서 연다. 일반 화면이면 입력창 위를
  // 차지하지 않도록 /progress 로 열 때까지 기다린다.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!autoOpened && e.viewport?.isFullscreen === true) {
      autoOpened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }

    if (e.props.hasSurvey) return next(e)

    // 코드를 고치고 검증 없이 끝났으면 입력창 위에 경고 줄을 그린다
    const report = await read($, evidence)
    const isWarning = report !== null && report.verdict !== 'verified' && !(await read($, evidenceHidden))
    const state = (await read($, vibeHidden)) ? null : await read($, snapshot)
    if (!isWarning && state === null) return next(e)

    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const vibe =
      state === null
        ? null
        : vibeBand(elements, state, await read($, check), {
            onCheck: () => {
              void $.ui.open({ id: PANE, title: TITLE })
              void runCheck($)
            },
            onHide: () => void update($, vibeHidden, () => true),
          })
    // 아래쪽 mod가 그리는 띠를 가리지 않도록 이 줄들 밑에 그대로 둔다
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {isWarning && (
          <Box>
            <Text color={VERDICT_COLOR[report.verdict]} wrap="truncate-end">
              {VERDICT_LABEL[report.verdict]} · {filesLine(report.files)}{' '}
            </Text>
            <Button key="evidence-hide" label="숨기기" onPress={() => update($, evidenceHidden, () => true)} />
          </Box>
        )}
        {vibe}
        {below}
      </Box>
    )
  })

  on('command.run', { command: 'vibe-status' }, async $ => {
    await update($, vibeHidden, () => false)
    const found = await refresh($)

    return {
      text:
        found === null
          ? '이 프로젝트는 vibe가 추적하지 않아요.'
          : `vibe ${found.state} · ${found.scenarios.filter(one => one.last === 'pass').length}/${found.scenarios.length} pass` +
            (found.next !== '' ? `\n다음: ${found.next}` : ''),
    }
  })

  on('command.run', { command: 'vibe-check' }, async $ => {
    const running = await read($, check)
    if (running?.status === 'running') return { text: '이미 검사가 돌고 있어요.' }

    void $.ui.open({ id: PANE, title: TITLE })
    const result = await runCheck($)

    return { text: checkLine(result) }
  })

  on('command.run', { command: 'evidence' }, async $ => ({ text: summary(await read($, evidence)) }))

  on('command.run', { command: 'progress' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: opened.isPlaced
        ? '작업 진행 패널을 열었어요.'
        : '패널이 대기 중이에요. 터미널 창을 더 넓히면 나타나요.',
    }
  })

  on('turn.start', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const prompt = oneLine(e.text)

    await update($, turn, (prev): Turn => ({
      // 이어서 진행하는 턴(text가 빈 경우)은 이전 요청을 그대로 둔다
      prompt: prompt || prev?.prompt || '(이어서 진행)',
      status: 'running',
      startedAt,
    }))
    await update($, steps, () => [])
    // 끝난 서브에이전트는 비우고, 백그라운드로 아직 도는 것은 남긴다
    await update($, agents, list => list.filter(agent => agent.status === 'run'))
    // 계획이 전부 끝났으면 새 작업에서 비운다
    await update($, plan, list =>
      list.length > 0 && list.every(item => item.status === 'completed') ? [] : list,
    )
    await update($, now, () => startedAt)
    tracker.reset()
    await update($, evidence, () => null)
    await update($, evidenceHidden, () => false)

    ticker?.cancel()
    ticker = $.clock.every(1000, () => {
      void $.clock.now().then(t => update($, now, () => t))
    })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const endedAt = await $.clock.now()
    const status = statusOf(e.reason)
    const agentId = e.agentId

    if (agentId === undefined) {
      await update($, turn, (prev): Turn | null => (prev ? { ...prev, status, endedAt } : prev))
    } else {
      await update($, agents, list =>
        list.map(agent => (agent.id === agentId ? { ...agent, status, endedAt } : agent)),
      )
    }
    await update($, now, () => endedAt)
    await stopTickerIfIdle($)
    if (agentId === undefined && e.reason === 'answer') await judgeEvidence($)
    if (agentId === undefined) await refresh($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>

    if (PLAN_TOOLS.has(e.tool)) {
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran

      if (e.tool === 'TodoWrite') {
        const todos = (args.todos ?? []) as { content: string; status: PlanItem['status'] }[]
        await update($, plan, () =>
          todos.map((todo, i) => ({ id: `todo-${i}`, text: todo.content, status: todo.status })),
        )
      } else if (e.tool === 'TaskCreate') {
        const task = (ran.result as { task?: { id: string; subject: string } } | undefined)?.task
        if (task) {
          await update($, plan, list => [
            ...list,
            { id: task.id, text: task.subject, status: 'pending' as const },
          ])
        }
      } else if (e.tool === 'TaskUpdate') {
        const id = String(args.taskId)
        const status = args.status as PlanItem['status'] | 'deleted' | undefined
        const subject = typeof args.subject === 'string' ? args.subject : undefined
        await update($, plan, list =>
          status === 'deleted'
            ? list.filter(item => item.id !== id)
            : list.map(item =>
                item.id === id
                  ? { ...item, status: status ?? item.status, text: subject ?? item.text }
                  : item,
              ),
        )
      }

      return ran
    }

    const step: Step = {
      id: e.tool_use_id,
      tool: e.tool,
      label: describe(e.tool, args),
      status: 'run',
      isSub: e.agentId !== undefined,
      startedAt: await $.clock.now(),
    }
    await update($, steps, list => [...list, step].slice(-MAX_STEPS))
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      const line = step.label ? `${step.tool} ${step.label}` : step.tool
      await update($, agents, list =>
        list.map(agent =>
          agent.id === agentId ? { ...agent, tools: agent.tools + 1, current: line } : agent,
        ),
      )
    }

    const finish = async (status: Step['status']) => {
      const endedAt = await $.clock.now()
      await update($, steps, list =>
        list.map(one => (one.id === step.id ? { ...one, status, endedAt } : one)),
      )
    }

    try {
      const ran = await next(e)
      await finish(ran.deny !== undefined ? 'deny' : ran.isError === true ? 'fail' : 'ok')
      tracker.record(e.tool, args, ran)
      // 파일을 고친 즉시 vibe 상태를 다시 읽되, 도구 결과는 기다리게 하지 않는다
      if (touchesVibe(e.tool, args)) void refresh($)

      return ran
    } catch (err) {
      await finish('fail')
      throw err
    }
  }).catch(($, e, next) => next(e)) // 표시용 mod다: 이 훅이 실패해도 도구 실행은 막지 않는다

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.agentId === undefined) return ran

    // 표시용 mod다: 기록이 실패해도 서브에이전트 실행에는 손대지 않는다
    try {
      const agent: SubAgent = {
        id: ran.agentId,
        type: e.subagentType,
        description: oneLine(e.description),
        isBackground: e.background,
        status: 'run',
        startedAt: await $.clock.now(),
        tools: 0,
        current: '',
      }
      await update($, agents, list => [...list.filter(one => one.id !== agent.id), agent])
    } catch {}

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const current = await read($, turn)
    const planList = await read($, plan)
    const stepList = await read($, steps)
    const agentList = await read($, agents)
    const clock = await read($, now)
    const report = await read($, evidence)
    const state = await read($, snapshot)
    const vibe = state === null ? null : vibeSection($.ui.resolve(e), state, await read($, check))

    if (current === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>아직 진행 중인 작업이 없어요.</Text>
          <Text dimColor>요청을 보내면 여기에 진행 상황이 표시돼요.</Text>
          {vibe?.tree}
        </Box>
      )
    }

    const done = planList.filter(item => item.status === 'completed').length
    const okCount = stepList.filter(s => s.status === 'ok').length
    const failCount = stepList.filter(s => s.status === 'fail' || s.status === 'deny').length
    const total = (current.endedAt ?? clock) - current.startedAt

    // 패널 높이에 맞춰 최근 스텝만 보여준다
    const rows = e.props.scroll.bodyRows
    const used =
      6 + (planList.length > 0 ? planList.length + 2 : 0) + (agentList.length > 0 ? agentList.length * 2 + 2 : 0) +
      (report !== null ? 3 : 0) + (vibe?.rows ?? 0)
    const room = Math.max(3, rows - used)
    const shown = stepList.slice(-room)
    const hidden = stepList.length - shown.length

    return (
      <Box flexDirection="column">
        <Text bold>작업</Text>
        <Text wrap="truncate-end">{current.prompt}</Text>
        <Text color={TURN_COLOR[current.status]}>
          {TURN_LABEL[current.status]} · {elapsed(total)}
        </Text>

        {planList.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              계획 {done}/{planList.length}
            </Text>
            {planList.map(item => (
              <Text
                key={item.id}
                wrap="truncate-end"
                color={item.status === 'in_progress' ? 'warning' : undefined}
                dimColor={item.status === 'completed'}
              >
                {PLAN_MARK[item.status]} {item.text}
              </Text>
            ))}
          </Box>
        )}

        {agentList.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>
              서브에이전트 {agentList.filter(agent => agent.status === 'run').length}/{agentList.length}
            </Text>
            {agentList.map(agent => (
              <Box key={agent.id} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color={AGENT_COLOR[agent.status]}>{AGENT_MARK[agent.status]}</Text> {agent.type}
                  {agent.description ? ` · ${agent.description}` : ''}
                  {agent.isBackground ? ' (백그라운드)' : ''}{' '}
                  <Text dimColor>{elapsed((agent.endedAt ?? clock) - agent.startedAt)}</Text>
                </Text>
                <Text wrap="truncate-end" dimColor>
                  {'  '}도구 {agent.tools}개{agent.status === 'run' && agent.current ? ` · ${agent.current}` : ''}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {report !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>검증</Text>
            <Text color={VERDICT_COLOR[report.verdict]} wrap="truncate-end">
              {VERDICT_LABEL[report.verdict]} · {filesLine(report.files)}
            </Text>
            {report.command !== '' && (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {report.command}
              </Text>
            )}
          </Box>
        )}

        {vibe?.tree}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>
            스텝 {stepList.length}{' '}
            <Text dimColor>
              (✓{okCount}
              {failCount > 0 ? ` ✗${failCount}` : ''})
            </Text>
          </Text>
          {stepList.length === 0 && <Text dimColor>아직 실행한 스텝이 없어요.</Text>}
          {hidden > 0 && <Text dimColor>… 이전 스텝 {hidden}개</Text>}
          {shown.map(step => (
            <Text key={step.id} wrap="truncate-end" dimColor={step.status === 'ok'}>
              <Text color={STEP_COLOR[step.status]}>{STEP_MARK[step.status]}</Text>
              {step.isSub ? ' ↳' : ''} {step.tool}
              {step.label ? ` ${step.label}` : ''}{' '}
              <Text dimColor>{elapsed((step.endedAt ?? clock) - step.startedAt)}</Text>
            </Text>
          ))}
        </Box>
      </Box>
    )
  })
}
