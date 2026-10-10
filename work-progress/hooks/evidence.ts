import type { ToolCallResult } from 'claude-code'

import type { Report, Verdict } from '../types'

// 검증 감시: 코드를 고친 뒤 테스트·빌드 없이 끝난 요청을 잡아낸다

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

/** 고쳐도 검증이 필요 없는 문서·메모 파일 */
const DOC_FILE = /\.(md|mdx|txt|rst|adoc|log|csv)$/i

/** 테스트·빌드·타입검사·린트로 치는 명령 */
const VERIFY_COMMAND = new RegExp(
  [
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|check|typecheck|type-check|lint)\b`,
    String.raw`\bbun\s+test\b`,
    String.raw`\b(npx\s+|bunx\s+)?(tsc|vitest|jest|mocha|eslint|biome|playwright)\b`,
    String.raw`\b(pytest|mypy|pyright|ruff|py_compile|unittest|tox|nox)\b`,
    String.raw`\b(cargo|go)\s+(test|build|check|vet|clippy)\b`,
    String.raw`\b(dotnet|mvn|gradle|gradlew|swift|deno)\s+(test|build|check)\b`,
    String.raw`\bmake\s+(test|check|build|lint)\b`,
    String.raw`\bclaude\s+plugin\s+(test|validate)\b`,
  ].join('|'),
  'i',
)

export const isVerifyCommand = (command: string) => VERIFY_COMMAND.test(command)
export const isCodeFile = (path: string) => path !== '' && !DOC_FILE.test(path)

/** 고친 파일과 검증 기록으로 판정한다. 검증은 마지막 수정 뒤에 돌아야 인정한다. */
export const judge = (
  files: string[],
  verifiedAfterEdit: boolean,
  lastVerifyFailed: boolean,
): Verdict | null => {
  if (files.length === 0) return null
  if (!verifiedAfterEdit) return 'unverified'

  return lastVerifyFailed ? 'failed' : 'verified'
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  verified: '✓ 수정 뒤 검증 통과',
  unverified: '⚠ 검증 없이 끝남',
  failed: '✗ 검증 실패한 채 끝남',
}
export const VERDICT_COLOR: Record<Verdict, string> = {
  verified: 'success',
  unverified: 'warning',
  failed: 'error',
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

export const filesLine = (files: string[]) =>
  files.length === 1 ? baseName(files[0] ?? '') : `${baseName(files[0] ?? '')} 외 ${files.length - 1}개`

/** 한 요청 동안 고친 코드 파일과 마지막 검증을 모은다. 서브에이전트가 한 것도 함께 센다. */
export const createTracker = () => {
  let files = new Set<string>()
  let verifiedAfterEdit = false
  let lastVerifyFailed = false
  let lastCommand = ''

  return {
    reset() {
      files = new Set()
      verifiedAfterEdit = false
      lastVerifyFailed = false
      lastCommand = ''
    },

    /** 도구 실행이 끝난 뒤 수정·검증을 기록한다. */
    record(tool: string, args: Record<string, unknown>, ran: ToolCallResult) {
      if (ran.deny !== undefined) return

      if (EDIT_TOOLS.has(tool) && ran.isError !== true) {
        const path = String(args.file_path ?? args.notebook_path ?? '')
        if (isCodeFile(path)) {
          files.add(path)
          // 검증 뒤에 또 고쳤으면 그 검증은 더 이상 증거가 아니다
          verifiedAfterEdit = false
        }
      } else if (SHELL_TOOLS.has(tool)) {
        const command = String(args.command ?? '')
        if (isVerifyCommand(command)) {
          verifiedAfterEdit = true
          lastVerifyFailed = ran.isError === true
          lastCommand = command.replace(/\s+/g, ' ').trim()
        }
      }
    },

    /** 고친 코드 파일이 없으면 null */
    report(): Report | null {
      const list = [...files]
      const verdict = judge(list, verifiedAfterEdit, lastVerifyFailed)

      return verdict === null ? null : { verdict, files: list, command: lastCommand }
    },
  }
}

export const summary = (report: Report | null) => {
  if (report === null) return '마지막 요청에서 고친 코드 파일이 없어요.'

  const head =
    report.verdict === 'verified'
      ? '✓ 마지막 수정 뒤에 검증을 돌렸고 통과했어요.'
      : report.verdict === 'failed'
        ? '✗ 마지막 수정 뒤에 돌린 검증이 실패했어요.'
        : '⚠ 마지막 수정 뒤에 돌린 테스트·빌드가 없어요.'

  return [head, `• 고친 파일 — ${report.files.join(', ')}`, `• 검증 명령 — ${report.command || '없음'}`].join('\n')
}
