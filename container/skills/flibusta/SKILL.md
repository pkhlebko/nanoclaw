---
name: flibusta
description: Search and download books from Flibusta. Use when the user asks to find, download, or send a book.
---

# Flibusta — search and download books

## IMPORTANT: always use the ready-made scripts

Do NOT write your own search/download code. Use the scripts below — they are already tested.

---

## Step 1: search for a book

Save and run this script (substitute the actual query):

```bash
python3 /home/node/.claude/skills/flibusta/search.py "Master and Margarita"
```

Output format:
```
1. Title — Author [id=12345] dl=/b/12345/fb2
2. ...
```

If no lines are returned — the book was not found.

---

## Step 2: choose an edition

- 1 result → take it
- Multiple with different translators → WebSearch "best translation [title] [author]" → explain the choice
- Multiple editions by the same translator → take the one with the highest book_id (usually newer)
- No clear winner → send_message with the list, wait for the user's choice

---

## Step 3: download

Take the `dl=` value from the search result (e.g. `/b/12345/fb2`). Save and run:

```bash
python3 /home/node/.claude/skills/flibusta/download.py "/b/12345/fb2" "Bulgakov" "Master and Margarita"
```

The script prints one of:
```
OK: /workspace/group/media/Bulgakov_Master_and_Margarita.fb2
ERROR: ...error message...
```

On `OK:` — send the file via `mcp__nanoclaw__send_media`.
On `ERROR:` — report the error to the user.

---

## Step 4: send

```
mcp__nanoclaw__send_media(
  workspace_path="media/Bulgakov_Master_and_Margarita.fb2",
  kind="document",
  caption="Bulgakov — Master and Margarita"
)
```

---

## If book not found

Reply: "Book '[query]' not found on Flibusta. Try refining the title or author name."
