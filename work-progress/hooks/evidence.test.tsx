import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { isCodeFile, isVerifyCommand, judge } from './evidence'

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

const answer = (turnId: string) =>
  ({ answer: '끝', durationMs: 1_000, reason: 'answer', isAborted: false, turnId }) as const

const stub = (on: On, failing?: RegExp) => {
  mock.clock(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // 플러그인이 아무것도 그리지 않을 때 엔진이 그리는 빈 줄
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('tool.call', (_, e) => {
    const command = String((e as unknown as { command?: string }).command ?? '')
    return failing?.test(command) ? { result: 'exit 1', isError: true } : { result: 'ok' }
  })
}

const edit = ($: Engine, file_path: string) =>
  $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })
const run = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

test('검증 명령과 문서 파일을 가려낸다', async () => {
  expect(isVerifyCommand('npm test')).toBe(true)
  expect(isVerifyCommand('pnpm run build')).toBe(true)
  expect(isVerifyCommand('.venv/bin/python -m pytest tests -q')).toBe(true)
  expect(isVerifyCommand('npx -y -p typescript tsc -p .')).toBe(true)
  expect(isVerifyCommand('cargo test')).toBe(true)
  expect(isVerifyCommand('claude plugin test ./mod')).toBe(true)
  expect(isVerifyCommand('git status')).toBe(false)
  expect(isVerifyCommand('ls -la')).toBe(false)

  expect(isCodeFile('src/app.ts')).toBe(true)
  expect(isCodeFile('README.md')).toBe(false)
  expect(isCodeFile('notes.txt')).toBe(false)
})

test('판정: 수정 없음 · 검증 없음 · 실패 · 통과', async () => {
  expect(judge([], false, false)).toBe(null)
  expect(judge(['a.ts'], false, false)).toBe('unverified')
  expect(judge(['a.ts'], true, true)).toBe('failed')
  expect(judge(['a.ts'], true, false)).toBe('verified')
})

test('코드를 고치고 검증 없이 끝나면 경고한다', async ($, on) => {
  stub(on)
  await $.turn.start({ text: '고쳐줘', turnId: 't1' })
  await edit($, String.raw`C:\proj\src\app.ts`)
  await $.turn.complete(answer('t1'))

  const ui = await $.ui.mount(BAND)
  expect(await ui.findAll({ type: 'Text', text: /검증 없이 끝남 · app\.ts/ })).toHaveLength(1)
})

test('수정 뒤 테스트가 통과하면 조용하다', async ($, on) => {
  stub(on)
  await $.turn.start({ text: '고쳐줘', turnId: 't2' })
  await edit($, 'src/app.ts')
  await run($, 'npm test')
  await $.turn.complete(answer('t2'))

  const ui = await $.ui.mount(BAND)
  expect(await ui.findAll({ type: 'Text', text: /검증/ })).toHaveLength(0)
})

test('테스트 뒤에 또 고치면 다시 미검증이다', async ($, on) => {
  stub(on)
  await $.turn.start({ text: '고쳐줘', turnId: 't3' })
  await edit($, 'src/a.ts')
  await run($, 'npm test')
  await edit($, 'src/b.ts')
  await $.turn.complete(answer('t3'))

  const ui = await $.ui.mount(BAND)
  expect(await ui.findAll({ type: 'Text', text: /검증 없이 끝남 · a\.ts 외 1개/ })).toHaveLength(1)
})

test('검증이 실패한 채 끝나면 실패로 경고한다', async ($, on) => {
  stub(on, /pytest/)
  await $.turn.start({ text: '고쳐줘', turnId: 't4' })
  await edit($, 'app.py')
  await run($, 'pytest -q')
  await $.turn.complete(answer('t4'))

  const ui = await $.ui.mount(BAND)
  expect(await ui.findAll({ type: 'Text', text: /검증 실패한 채 끝남/ })).toHaveLength(1)
})

test('문서만 고치면 경고하지 않는다', async ($, on) => {
  stub(on)
  await $.turn.start({ text: '문서 고쳐줘', turnId: 't5' })
  await edit($, 'README.md')
  await $.turn.complete(answer('t5'))

  const ui = await $.ui.mount(BAND)
  expect(await ui.findAll({ type: 'Text', text: /검증/ })).toHaveLength(0)
})

test('/evidence 가 고친 파일과 검증 명령을 알려준다', async ($, on) => {
  stub(on)
  await $.turn.start({ text: '고쳐줘', turnId: 't6' })
  await edit($, 'src/app.ts')
  await run($, 'npx tsc -p .')
  await $.turn.complete(answer('t6'))

  const out = await $.command.run({
    command: 'evidence',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
  expect(out.text).toContain('통과')
  expect(out.text).toContain('npx tsc -p .')
})

test('패널에 검증 판정이 함께 보인다', async ($, on) => {
  stub(on)
  await $.turn.start({ text: '고쳐줘', turnId: 't7' })
  await edit($, 'src/app.ts')
  await run($, 'npm test')
  await $.turn.complete(answer('t7'))

  const ui = await $.ui.mount({
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
  })
  expect(await ui.findAll({ type: 'Text', text: /수정 뒤 검증 통과 · app\.ts/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /npm test/ })).toHaveLength(2) // 검증 줄 + 스텝 줄
})

test('전체화면에서 경고가 떠 있어도 패널은 알아서 열린다', async ($, on) => {
  stub(on)
  const opened: string[] = []
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  await $.turn.start({ text: '고쳐줘', turnId: 't8' })
  await edit($, 'src/app.ts')
  await $.turn.complete(answer('t8'))

  const ui = await $.ui.mount({ ...BAND, viewport: { columns: 160, rows: 40, isFullscreen: true } })
  expect(await ui.findAll({ type: 'Text', text: /검증 없이 끝남/ })).toHaveLength(1)
  expect(opened).toEqual(['work-progress'])
})
