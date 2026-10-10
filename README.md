# claude-mods

Personal Claude Code mods.

| Mod | What it does |
| --- | --- |
| `work-progress` | Side pane with the running task, plan, steps and subagents; warns when code was edited and the turn ended without a test or build. Commands: `/progress`, `/evidence`. |
| `vibe-status` | One line above the prompt with the current vibe state (`vibe state --json`). Needs the `vibe` CLI on PATH. Command: `/vibe-status`. |

## Install

```
claude plugin marketplace add su-record/claude-mods
claude plugin install work-progress@su-record-mods
claude plugin install vibe-status@su-record-mods
```

## Check a mod

```
claude plugin validate <mod folder>
claude plugin test <mod folder>
```
