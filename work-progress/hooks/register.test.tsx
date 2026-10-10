import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { describe, elapsed } from './register'

const PANE_PROPS = {
  title: '작업 진행',
  isFocused: false,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const mountPane = ($: Engine) =>
  $.ui.mount({
    plugin: 'work-progress',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-progress',
    props: PANE_PROPS,
  })

test('도구 호출을 읽기 쉬운 한 줄로 바꾼다', async () => {
  expect(describe('Bash', { command: 'ls -la', description: '파일 목록 보기' })).toBe('파일 목록 보기')
  expect(describe('Bash', { command: 'ls\n  -la' })).toBe('ls -la')
  expect(describe('Read', { file_path: 'C:\\a\\b\\AGENTS.md' })).toBe('AGENTS.md')
  expect(describe('Grep', { pattern: 'todo' })).toBe('todo')
  expect(describe('Unknown', {})).toBe('')
})

test('경과 시간을 한국어로 쓴다', async () => {
  expect(elapsed(4_000)).toBe('4초')
  expect(elapsed(83_000)).toBe('1분 23초')
  expect(elapsed(3_720_000)).toBe('1시간 2분')
})

test('작업이 없으면 안내 문구를 보여준다', async $ => {
  const ui = await mountPane($)
  expect(await ui.findAll({ type: 'Text', text: /진행 중인 작업이 없어요/ })).toHaveLength(1)
})

test('요청·스텝·완료 상태를 패널에 그린다', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ text: 'oracle 서버 상태 점검해줘', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'uptime', description: '서버 가동 시간 확인' })

  const ui = await mountPane($)
  expect(await ui.findAll({ type: 'Text', text: /oracle 서버 상태 점검해줘/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /진행 중/ })).toHaveLength(1)

  // 1초마다 경과 시간이 갱신된다
  await clock.advance(83_000)
  expect(await ui.findAll({ type: 'Text', text: /진행 중 · 1분 23초/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /Bash 서버 가동 시간 확인/ })).toHaveLength(1)

  await $.turn.complete({ answer: '끝', durationMs: 83_000, reason: 'answer', isAborted: false, turnId: 't1' })
  expect(await ui.findAll({ type: 'Text', text: /완료/ })).toHaveLength(1)
})

test('TodoWrite 계획을 체크리스트로 보여준다', async ($, on) => {
  mock.clock(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))

  await $.turn.start({ text: '작업', turnId: 't2' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: '조사', status: 'completed', activeForm: '조사 중' },
      { content: '구현', status: 'in_progress', activeForm: '구현 중' },
      { content: '검증', status: 'pending', activeForm: '검증 중' },
    ],
  })

  const ui = await mountPane($)
  expect(await ui.findAll({ type: 'Text', text: /계획 1\/3/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /▶ 구현/ })).toHaveLength(1)
  // 계획 도구는 스텝 목록에 섞이지 않는다
  expect(await ui.findAll({ type: 'Text', text: /TodoWrite/ })).toHaveLength(0)
})

const mountBand = ($: Engine, isFullscreen: boolean) =>
  $.ui.mount({
    plugin: 'work-progress',
    surface: 'terminal',
    component: 'AbovePrompt',
    viewport: { columns: 160, rows: 40, isFullscreen },
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 5,
      bodyColumns: 160,
      scroll: { offset: 0, bodyRows: 5 },
      view: {},
    },
  })

test('일반 화면에서는 패널을 알아서 열지 않는다', async ($, on) => {
  const opened: string[] = []
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))

  await mountBand($, false)
  expect(opened).toEqual([])
})

test('전체화면이면 사이드 패널을 한 번만 알아서 연다', async ($, on) => {
  const opened: string[] = []
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))

  await mountBand($, true)
  await mountBand($, true)
  expect(opened).toEqual(['work-progress'])
})

test('서브에이전트의 진행·도구 수·완료를 보여준다', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a1' }))

  await $.turn.start({ text: '코드 조사해줘', turnId: 't3' })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: '찾아봐',
    description: '인증 코드 찾기',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
  })
  // 서브에이전트 루프의 도구 호출은 agentId를 달고 온다
  await $.tool.call({ tool: 'Grep', pattern: 'login', agentId: 'a1' } as never)

  const ui = await mountPane($)
  expect(await ui.findAll({ type: 'Text', text: /서브에이전트 1\/1/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /Explore · 인증 코드 찾기/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /도구 1개 · Grep login/ })).toHaveLength(1)

  await clock.advance(5_000)
  await $.turn.complete({
    answer: '찾음',
    durationMs: 5_000,
    reason: 'answer',
    isAborted: false,
    turnId: 't3',
    agentId: 'a1',
  })
  expect(await ui.findAll({ type: 'Text', text: /서브에이전트 0\/1/ })).toHaveLength(1)
  // 서브에이전트가 끝나도 메인 작업은 아직 진행 중이다
  expect(await ui.findAll({ type: 'Text', text: /진행 중/ })).toHaveLength(1)
})
