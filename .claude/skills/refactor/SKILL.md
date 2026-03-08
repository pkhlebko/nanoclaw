---
name: refactor
description: Refactor a source file to improve code quality. Splits god files/functions, extracts constants, removes duplication, improves SRP and testability. Accepts a file path as argument or asks for one.
---

# NanoClaw Refactoring Skill

Systematically refactors a single source file to meet the project's code quality standards.

## Workflow

### Step 1 — Identify target

If no file path was provided as an argument, ask:
> Which file do you want to refactor? (e.g. `src/channels/telegram.ts`)

Read the target file in full.

### Step 2 — Analysis

Produce a structured report covering:

- **SRP violations** — which distinct responsibilities are mixed in this file/class?
- **God functions** — functions longer than 80 lines (list them with line ranges)
- **Duplication** — same logic appearing in 2+ places (list both locations)
- **Magic constants** — inline numbers or strings that should be named constants
- **Module-level mutable state** — variables that make functions stateful/untestable
- **Long parameter lists** — functions with more than 5 parameters

### Step 3 — Split plan

Based on the analysis, propose a concrete refactoring structure:

- Which new files to create and what each one contains
- Which functions to extract with their new clean signatures
- Which constants move to `src/config.ts` (or become named exports at the top of the file)
- Which duplicates to merge into a single shared utility
- Which module-level state to collect into an explicit object

**Show the plan to the user and wait for confirmation before writing any code.**

Use `AskUserQuestion` if there are meaningful trade-offs the user should decide (e.g., whether a helper belongs in `config.ts` vs stays local).

### Step 4 — Implementation

Execute in this order to keep the build green at every step:

1. **Create new utility/helper files** — pure functions and types only, no changes to the source file yet
2. **Rewrite the source file** — import and use the new utilities; keep the public API identical
3. **Update all imports** — grep the codebase for old import paths and fix them
4. **Remove the eslint-disable** — if the file is now ≤300 lines, delete the `/* eslint-disable max-lines */` comment at the top
5. **Move constants** — add any extracted constants to `src/config.ts` or the top of the relevant file as named exports

### Step 5 — Verification

Run in this exact order and fix any failures before proceeding to the next step:

```bash
npm run fix       # auto-fix lint issues + prettier
npm run lint      # must report 0 errors in all affected files
npm test          # all tests must be green
npm run typecheck # TypeScript must be happy
```

The refactoring is complete only when all four commands pass with no errors.

---

## Refactoring Patterns Reference

### God class with one giant method
Extract each logical group of handlers into its own function or module.
Example: `TelegramChannel.connect()` (400 lines) → extract `registerCommandHandlers()`, `registerMediaHandlers()`, `registerTextHandler()` as separate functions called from `connect()`.

### Duplicated handler boilerplate (e.g., photo/video/document handlers)
Replace with a single generic function parameterized by the differences:
```ts
// Before: three 60-line handlers
// After:
function handleMediaMessage(ctx, opts: { maxBytes: number; kind: 'image' | 'file'; ext: string }) { ... }
```

### Duplicated calculation logic
Extract to a shared utility module (e.g., `src/schedule-utils.ts`):
```ts
export function computeNextRun(schedule: TaskSchedule): Date { ... }
```
Then import in both `ipc.ts` and `task-scheduler.ts`.

### Module-level mutable state
Collect into a typed state object and pass explicitly:
```ts
// Before: let lastTimestamp = 0; let sessions = new Map(); ...
// After:
interface AppState { lastTimestamp: number; sessions: Map<string, string>; ... }
function processGroupMessages(state: AppState, ...) { ... }
```

### Magic constants
Move to `src/config.ts` (global) or top of the file as a named export (local):
```ts
// Before: if (buffer.length > 5 * 1024 * 1024)
// After in config.ts: export const TELEGRAM_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
```

### Functions with too many parameters
Group related parameters into an options object:
```ts
// Before: runAgent(group, prompt, chatJid, model, attachments, onOutput)
// After:  runAgent(group: Group, opts: RunAgentOptions)
```

---

## Quality Checklist (must all be true when done)

- [ ] All affected files are ≤300 lines (or have a justified `eslint-disable` with a new TODO)
- [ ] No function is longer than 80 lines
- [ ] No logic is duplicated across files
- [ ] No magic numbers or strings inline (all named constants)
- [ ] No module-level mutable state (or it is explicitly passed as a parameter)
- [ ] `npm run lint` reports 0 errors
- [ ] `npm test` is green
- [ ] `npm run typecheck` is clean
