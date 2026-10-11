import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { parseCheck, summarize, turnedStale } from './vibe'

const BAND = {
  plugin: 'work-progress',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 5,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'work-progress',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'work-progress',
  props: {
    title: '작업 진행',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const state = (lasts: Record<string, string>, open = 0) =>
  JSON.stringify({
    state: 'RUNNING',
    stage: 'build',
    next: 'build surface first, then one vibe check --all',
    scenarios: Object.entries(lasts).map(([id, last]) => ({ id, last })),
    inbox: { open },
  })

const CHECKED = JSON.stringify({
  passed: 1,
  failed: 1,
  outcomes: [
    { id: 'compat', status: 'pass', ms: 1200 },
    { id: 'surface', status: 'fail', ms: 300, reason: 'expected 3 commands\nfound 4' },
  ],
})

const BLOCKED = JSON.stringify({ error: 'local execution consent required', code: 3 })

type World = { state: string; check: string; asked: string[]; toasts: string[]; opened: string[]; isMissing?: boolean }

// 엔진 자리: 프로젝트 루트, vibe 명령의 답, 알림, 그리고 mod가 넘길 때 엔진이 그리는 빈 줄
const stub = (on: On, world: World) => {
  mock.clock(on)
  on('session.root', () => ({ value: '/project' }))
  on('process.run', (_, e) => {
    world.asked.push(e.argv.join(' '))
    // vibe가 설치되지 않은 컴퓨터: 없는 명령을 실행하려 할 때처럼 실패한다
    if (world.isMissing) throw new Error('spawn vibe ENOENT')

    return {
      value: {
        exitCode: 0,
        stdout: e.argv[1] === 'check' ? world.check : world.state,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.toast', (_, e) => (world.toasts.push(e.text), { value: undefined }))
  on('ui.open', (_, e) => (world.opened.push(e.id), { value: { isPlaced: true } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const world = (lasts: Record<string, string>, check = CHECKED): World => ({
  state: state(lasts),
  check,
  asked: [],
  toasts: [],
  opened: [],
})

const command = ($: Engine, name: string) =>
  $.command.run({
    command: name,
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })

const texts = async (ui: { findAll: (q: { type: 'Text' }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(one => one.text).join('\n')

test('vibe 출력을 읽는다: 추적 안 함 · 검사 결과 · 동의 없음 · stale 전환', async () => {
  expect(summarize(JSON.stringify({ state: 'NONE', scenarios: [] }))).toBe(null)
  expect(summarize(state({ a: 'pass', b: 'stale' }, 2))).toEqual({
    state: 'RUNNING',
    stage: 'build',
    next: 'build surface first, then one vibe check --all',
    scenarios: [
      { id: 'a', last: 'pass' },
      { id: 'b', last: 'stale' },
    ],
    inboxOpen: 2,
  })

  const done = parseCheck(CHECKED, 0, 1500)
  expect(done.status).toBe('done')
  expect(done.outcomes[1]).toEqual({ id: 'surface', status: 'fail', ms: 300, reason: 'found 4' })
  expect(parseCheck(BLOCKED, 0, 10).status).toBe('blocked')

  const before = summarize(state({ a: 'pass', b: 'pass', c: 'fail' }))
  const after = summarize(state({ a: 'stale', b: 'pass', c: 'stale' }))
  expect(turnedStale(before, after)).toEqual(['a'])
  expect(turnedStale(null, after)).toEqual([])
})

test('입력창 위에 상태·개수·다음 단계를 그리고, 추적하지 않는 폴더면 그리지 않는다', async ($, on) => {
  const w = world({ compat: 'pass', surface: 'fail', startup: 'stale' })
  stub(on, w)

  await command($, 'vibe-status')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const shown = await texts(ui)
    expect(shown).toContain('vibe RUNNING')
    expect(shown).toContain('1/3 pass')
    expect(shown).toContain('1 fail (surface)')
    expect(shown).toContain('1 stale')
    expect(shown).toContain('다음: build surface first')
    await ui.unmount()
  }

  w.state = JSON.stringify({ state: 'NONE', scenarios: [] })
  const out = await command($, 'vibe-status')
  expect(out.text).toContain('추적하지 않아요')
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /vibe/ })).toBeUndefined()
})

test('검사 버튼이 vibe check --all 을 돌리고 패널에 시나리오별 결과와 실패 이유를 보여준다', async ($, on) => {
  const w = world({ compat: 'stale', surface: 'stale' })
  stub(on, w)

  await command($, 'vibe-status')
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'vibe-check' })

  expect(w.asked).toContain('vibe check --all --json')
  expect(w.opened).toEqual(['work-progress'])
  expect(w.toasts.at(-1)).toContain('통과 1 · 실패 1')

  const shown = await texts(await $.ui.mount(PANE))
  expect(shown).toContain('검사 통과 1 · 실패 1')
  expect(shown).toContain('surface 0.3초 — found 4')
  expect(shown).toContain('compat 1.2초')
  // 실패가 통과보다 먼저 나온다
  expect(shown.indexOf('surface')).toBeLessThan(shown.indexOf('compat'))
})

test('동의가 없어 검사를 못 돌리면 그 이유를 그대로 알린다', async ($, on) => {
  const w = world({ compat: 'stale' }, BLOCKED)
  stub(on, w)

  const out = await command($, 'vibe-check')
  expect(out.text).toContain('검사 못 함: local execution consent required')
  expect(await texts(await $.ui.mount(PANE))).toContain('검사 못 함: local execution consent required')
})

test('파일을 고치면 바로 다시 읽고, 통과였던 시나리오가 stale이 되면 알린다', async ($, on) => {
  const w = world({ compat: 'pass', surface: 'pass' })
  stub(on, w)

  await command($, 'vibe-status')
  const before = w.asked.length
  await $.tool.call({ tool: 'Read', file_path: 'src/app.ts' })
  expect(w.asked.length).toBe(before)

  w.state = state({ compat: 'stale', surface: 'pass' })
  await $.tool.call({ tool: 'Edit', file_path: 'src/app.ts', old_string: 'a', new_string: 'b' })
  // 도구 결과를 붙잡지 않으려고 mod가 기다리지 않고 읽으므로, 그 읽기가 끝날 때까지 기다린다
  for (let i = 0; i < 200 && w.toasts.length === 0; i++) await command($, 'evidence')
  expect(w.asked.length).toBe(before + 1)
  expect(w.toasts).toEqual(['방금 수정으로 다시 검사가 필요해졌어요: compat'])

  const ui = await $.ui.mount(BAND)
  expect(await texts(ui)).toContain('1/2 pass')
})

test('숨기기로 vibe 줄을 내리고 /vibe-status 로 다시 올린다', async ($, on) => {
  stub(on, world({ compat: 'pass' }))

  await command($, 'vibe-status')
  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'vibe-hide' })
  expect(await ui.find({ type: 'Text', text: /vibe RUNNING/ })).toBeUndefined()

  await command($, 'vibe-status')
  expect(await ui.find({ type: 'Text', text: /vibe RUNNING/ })).toBeDefined()
})

test('vibe 명령이 없는 컴퓨터에서는 vibe 명령을 등록하지 않고, 한 번 확인한 뒤로는 실행하지 않는다', async ($, on) => {
  const w: World = { ...world({ compat: 'pass' }), isMissing: true }
  const registered: string[] = []
  stub(on, w)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => (registered.push(e.name), { value: { command: e.name } }))

  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['progress', 'evidence'])
  expect(w.asked).toEqual(['vibe --version'])

  await $.turn.start({ text: '고쳐줘', turnId: 'n1' })
  await $.tool.call({ tool: 'Edit', file_path: 'src/app.ts', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ answer: '끝', durationMs: 1_000, reason: 'answer', isAborted: false, turnId: 'n1' })
  expect(w.asked).toEqual(['vibe --version'])

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /vibe/ })).toBeUndefined()
  expect(await ui.findAll({ type: 'Text', text: /검증 없이 끝남 · app\.ts/ })).toHaveLength(1)
})

test('vibe 명령이 있으면 vibe 명령 두 개도 등록한다', async ($, on) => {
  const registered: string[] = []
  stub(on, world({ compat: 'pass' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => (registered.push(e.name), { value: { command: e.name } }))

  await $.session.start({ cwd: '/project', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual(['progress', 'evidence', 'vibe-status', 'vibe-check'])
})
