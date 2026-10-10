import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { VibeSnapshot } from '../types'

const VIBE_COMMAND = /\bvibe\b|dist\/cli\.js/

const snapshot = atom({ plugin: 'vibe-status', key: 'snapshot' } as const, null)
const isHidden = atom({ plugin: 'vibe-status', key: 'isHidden' } as const, false)

type StateReport = {
  state?: unknown
  stage?: unknown
  scenarios?: unknown
  inbox?: { open?: unknown }
}

// `vibe state --json` answers state NONE in a folder vibe does not track: nothing to show there.
export function summarize(text: string): VibeSnapshot | null {
  const report = JSON.parse(text) as StateReport

  if (typeof report.state !== 'string' || report.state === 'NONE') {
    return null
  }

  const scenarios = Array.isArray(report.scenarios)
    ? (report.scenarios as { id?: unknown; last?: unknown }[])
    : []
  const count = (last: string) => scenarios.filter(one => one.last === last).length

  return {
    state: report.state,
    stage: typeof report.stage === 'string' ? report.stage : '',
    total: scenarios.length,
    pass: count('pass'),
    fail: count('fail'),
    stale: count('stale'),
    failing: scenarios.filter(one => one.last === 'fail').map(one => String(one.id)),
    inboxOpen: typeof report.inbox?.open === 'number' ? report.inbox.open : 0,
  }
}

async function refresh($: EngineInterface): Promise<VibeSnapshot | null> {
  let found: VibeSnapshot | null = null

  try {
    const ran = await $.process.run(['vibe', 'state', '--json'], {
      cwd: await $.session.root(),
      timeoutMs: 15000,
    })

    found = ran.exitCode === 0 ? summarize(ran.stdout) : null
  } catch {
    found = null
  }

  await update($, snapshot, () => found)

  return found
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'vibe-status',
      description: 'Refresh the vibe state band and show it again',
    })
    await refresh($)

    return next(e)
  })

  on('command.run', { command: 'vibe-status' }, async $ => {
    await update($, isHidden, () => false)
    const found = await refresh($)

    return {
      text:
        found === null
          ? 'vibe tracks nothing in this project.'
          : `vibe ${found.state}: ${found.pass}/${found.total} pass.`,
    }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)

    if (VIBE_COMMAND.test(e.command)) {
      await refresh($)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, snapshot)
    const isQuiet = e.props.hasSurvey || now === null || (await read($, isHidden))

    if (isQuiet) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isDone = now.total > 0 && now.pass === now.total
    // Another mod may draw its own band beneath: keep it under this line instead of covering it.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold>vibe {now.state} </Text>
          {now.stage !== '' && <Text dimColor>· {now.stage} </Text>}
          <Text color={isDone ? 'success' : undefined}>
            · {now.pass}/{now.total} pass{' '}
          </Text>
          {now.fail > 0 && (
            <Text color="error">
              · {now.fail} fail ({now.failing.slice(0, 3).join(', ')}
              {now.failing.length > 3 ? ', …' : ''}){' '}
            </Text>
          )}
          {now.stale > 0 && <Text color="warning">· {now.stale} stale </Text>}
          {now.inboxOpen > 0 && <Text color="warning">· inbox {now.inboxOpen} </Text>}
          <Button key="vibe-hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })
}
