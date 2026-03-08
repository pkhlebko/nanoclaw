# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Code Quality Standards

After modifying source files or tests, always run: `npm run fix && npm run lint`

### File and function size
- Max **300 lines** per file (lint error: `max-lines`)
- Max **80 lines** per function (lint warn → will become error after refactoring)
- If the limit is exceeded — split first, then add code

### Single Responsibility Principle
- One file = one area of responsibility
- If a file mixes lifecycle + parsing + media handling → that is three files
- A class should have one reason to change

### Pure functions
- Prefer functions without side effects: takes arguments → returns a result
- Pass dependencies explicitly (parameters or a `deps` object), do not read module-level state
- Module-level mutable variables → collect into an explicit state object and pass it explicitly

### Constants
- All magic numbers and strings → `src/config.ts` (or top of file as named export for channel-specific ones)
- Forbidden: `24 * 60 * 60 * 1000` — use a named constant only

### DRY
- If logic is repeated in 2+ places → extract a shared utility
- Duplicate SQL → single function. Three identical media handlers → one `handleMediaMessage`. Double nextRun calculation → one `computeNextRun` utility

### Async
- Never fire-and-forget: always `await` or chain `.catch()` (lint error: `no-floating-promises`)

### Tracked technical debt
Files marked with `/* eslint-disable max-lines */` are tracked debt.
Use `/refactor src/path/to/file.ts` to tackle them systematically.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

**WARNING: never run `npm run dev` while the systemd service is active.**
Telegram only allows one `getUpdates` connection per bot token. A second instance causes a 409 Conflict that kills the production polling loop.

To test a startup safely:
```bash
systemctl --user stop nanoclaw   # stop first
npm run dev                       # then test
systemctl --user start nanoclaw  # restore when done
```

To verify code without starting the process, use:
```bash
npm run build    # compile only
npm test         # run tests only
```

After modifying source files or tests, always run:

```bash
npm run fix          # Auto-fix lint issues + format with prettier (do this first)
npm run lint         # Check remaining lint issues that need manual fixes
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
