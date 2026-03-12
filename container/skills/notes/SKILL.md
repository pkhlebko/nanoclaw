---
name: notes
description: Work with personal markdown notes (Obsidian vault). Use when the user asks to find a note, read it, create a new one, add to the daily journal, or save something to the knowledge base.
---

# Notes (MDNotes)

Notes are stored at `/workspace/extra/MDNotes` inside the container.

## Vault structure

```
MDNotes/
├── AI/                  # Notes about AI tools and models
├── AI generated/        # AI-generated content
├── Configs/             # Configuration notes
├── Daily notes/         # Daily journals (YYYY-MM-DD.md)
├── Diary/               # Personal diary
├── KB/                  # Knowledge base
├── Personal/            # Personal notes
├── Projects/            # Projects
├── _templates/          # Templates for new notes
└── CLAUDE.md            # AI instructions for the vault
```

## How to work with notes

### Search

```bash
# Search by content
grep -r "keyword" /workspace/extra/MDNotes/ --include="*.md" -l

# Search with context
grep -r "keyword" /workspace/extra/MDNotes/ --include="*.md" -C 2

# Search by filename
find /workspace/extra/MDNotes -name "*keyword*" -type f
```

### Read a note

```bash
cat "/workspace/extra/MDNotes/KB/Note title.md"
```

### Create a KB note

Path: `/workspace/extra/MDNotes/KB/{Title}.md`

```markdown
# Title

Note content.
```

### Create a daily note

Path: `/workspace/extra/MDNotes/Daily notes/YYYY-MM-DD.md`

Template (from `_templates/Daily note.md`):
```markdown
---
processed: false
tags: [DailyNote]
---

## ToDo

- [ ] ...

## Remarks

...
```

### Create a project note

Path: `/workspace/extra/MDNotes/Projects/{YYYY-MM-DD Title}/`

Create the directory and a `README.md` or main project file inside it.

## Rules

- Filenames may contain spaces (this is an Obsidian vault)
- Use the existing folder structure; do not create new top-level directories unless explicitly asked
- For notes without a clear category, use `KB/`
- Date format in filenames: `YYYY-MM-DD`
- Write notes in the language the user is using

## Response format

After creating or editing a note:
```
**Saved:** `KB/Note title.md`

**Content:**
[brief summary or opening lines]
```

After a search — show matching files with relevant excerpts.
