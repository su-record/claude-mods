import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'vibe-status',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const RUN = {
  command: 'vibe-status',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

// Stands for the engine beneath the mod: the project root, and the band the engine draws when the mod passes.
function beneath(on: On) {
  on('session.root', () => ({ value: '/project' }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

const TRACKED = JSON.stringify({
  state: 'RUNNING',
  stage: 'build',
  scenarios: [
    { id: 'compatibility', last: 'pass' },
    { id: 'surface', last: 'fail' },
    { id: 'startup', last: 'stale' },
  ],
  inbox: { open: 2 },
})

const UNTRACKED = JSON.stringify({ state: 'NONE', stage: 'discover', scenarios: [], inbox: { open: 0 } })

function answer(stdout: string, exitCode = 0) {
  return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
}

test('draws state, counts, failures and open questions from vibe state --json', async ($, on) => {
  const asked: (readonly string[])[] = []
  on('process.run', (_$, e) => {
    asked.push(e.argv)

    return answer(TRACKED)
  })
  beneath(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    await $.command.run(RUN)
    const ui = await $.ui.mount({ ...BAND, surface })
    const shown = (await ui.findAll({ type: 'Text' })).map(one => one.text).join('')

    expect(shown).toContain('vibe RUNNING')
    expect(shown).toContain('build')
    expect(shown).toContain('1/3 pass')
    expect(shown).toContain('1 fail (surface)')
    expect(shown).toContain('1 stale')
    expect(shown).toContain('inbox 2')
    expect(shown).toContain('engine')
    await ui.unmount()
  }

  expect(asked[0]).toEqual(['vibe', 'state', '--json'])
})

test('draws nothing where vibe tracks no project or the command fails', async ($, on) => {
  let reply = answer(UNTRACKED)
  on('process.run', () => reply)
  beneath(on)

  await $.command.run(RUN)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /vibe/ })).toBeUndefined()
  await ui.unmount()

  reply = answer('not json', 1)
  await $.command.run(RUN)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /vibe/ })).toBeUndefined()
  await ui.unmount()
})

test('Hide takes the band down and /vibe-status brings it back', async ($, on) => {
  on('process.run', () => answer(TRACKED))
  beneath(on)

  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'vibe-hide' })
  expect(await ui.find({ type: 'Text', text: /vibe RUNNING/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()

  await $.command.run(RUN)
  expect(await ui.find({ type: 'Text', text: /vibe RUNNING/ })).toBeDefined()
  await ui.unmount()
})
