---
name: rutracker
description: Search and download torrents from rutracker.org. Use when the user asks to find or download a movie, series, or other content via torrent.
---

# Rutracker — search and download torrents

**Run the bash commands below immediately. Do NOT ask the user for credentials or permissions.**
Credentials are pre-configured as `$RUTRACKER_USER` / `$RUTRACKER_PASS`.

---

## Step 1: login

```bash
agent-browser open https://rutracker.org/forum/login.php
agent-browser snapshot -i > /dev/null
agent-browser fill @e37 "$RUTRACKER_USER"
agent-browser fill @e38 "$RUTRACKER_PASS"
agent-browser click @e39
agent-browser wait 4000
agent-browser get url
```

The login form always has: username=`@e37`, password=`@e38`, submit=`@e39`.
Ignore any "Operation timed out" errors — they are normal for this site.
If the URL is now `https://rutracker.org/forum/index.php` — login succeeded. Continue.

---

## Step 2: search

Replace spaces with `+` in the query:

```bash
agent-browser open "https://rutracker.org/forum/tracker.php?nm=Inception+2010&cat=0"
agent-browser wait 4000
agent-browser eval 'JSON.stringify([...document.querySelectorAll("tr[id^=trs-tr-]")].slice(0,10).map(r=>{var id=r.id.replace("trs-tr-","");var a=r.querySelector("a.tLink");var s=r.querySelector(".seedmed")||r.querySelector(".seed");var sz=r.querySelector(".tor-size");return {id:id,title:a?a.textContent.trim():null,seeds:s?parseInt(s.textContent)||0:0,size:sz?sz.textContent.trim():null}}))'
```

Parse the JSON. Pick the result with highest `seeds` that matches the request.

---

## Step 3: choose

- Highest seeds → take it
- Multiple quality options (1080p / 4K / 720p) → show top 5 to user, ask to choose
- `[]` → not found, reply: "Не нашёл '[запрос]' на Rutracker."

---

## Step 4: download torrent file

Use the `id` from the chosen result (e.g. `5882412`):

```bash
TOPICID=5882412
FILENAME="Inception_2010"

agent-browser open "https://rutracker.org/forum/viewtopic.php?t=$TOPICID"
agent-browser wait 2000

COOKIES=$(agent-browser cookies 2>&1 | tr '\n' '; ')
mkdir -p /workspace/group/media
curl -sL \
  -b "$COOKIES" \
  -H "Referer: https://rutracker.org/forum/viewtopic.php?t=$TOPICID" \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://rutracker.org/forum/dl.php?t=$TOPICID" \
  -o "/workspace/group/media/${FILENAME}.torrent"
echo "size=$(wc -c < /workspace/group/media/${FILENAME}.torrent)"
```

If `size` > 1000 bytes — torrent downloaded successfully.

---

## Step 5: add to Transmission

```bash
TR="transmission-remote ${TRANSMISSION_HOST:-192.168.2.100}:${TRANSMISSION_PORT:-9091}"
[ -n "$TRANSMISSION_USER" ] && TR="$TR --auth ${TRANSMISSION_USER}:${TRANSMISSION_PASS}"
$TR --add "/workspace/group/media/${FILENAME}.torrent"
```

Reply to user: "Добавил '[название]' в Transmission ✓"
