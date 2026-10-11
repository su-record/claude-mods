# claude-mods

Personal Claude Code mods.

## work-progress

One mod that shows what the session is doing and whether the work was verified. The interface is Korean.

- **Side pane** (`/progress`): the running request, elapsed time, plan checklist, subagents, tool steps, and the vibe section below.
- **Verification watch**: when code was edited and the turn ended without a test or build, a toast and a warning line above the prompt. `/evidence` lists the edited files and the last verification command.
- **vibe line** above the prompt, in a folder vibe tracks: state, stage, pass/fail/stale counts, open questions and the next step. It is re-read right after a file edit, a `vibe` command and each turn; a scenario that turns from pass to stale raises a toast. `/vibe-status` re-reads it and brings a hidden line back.
- **Check button** on that line (or `/vibe-check`): runs `vibe check --all` and lists each scenario's result, time and failure reason in the pane, failures first.

The vibe parts need the `vibe` CLI on PATH; without it, or in a folder vibe does not track, they draw nothing.

## Install

```
claude plugin marketplace add su-record/claude-mods
claude plugin install work-progress@su-record-mods
```

## Check the mod

```
claude plugin validate work-progress
claude plugin test work-progress
```
