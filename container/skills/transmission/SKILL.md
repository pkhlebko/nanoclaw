---
name: transmission
description: Control Transmission torrent client. Add torrents, check download status, list active downloads.
---

# Transmission — torrent client control

Transmission runs at `$TRANSMISSION_HOST` (default: `192.168.2.100`), port `$TRANSMISSION_PORT` (default: `9091`).

## Helper alias

Build the base command once and reuse:

```bash
TR="transmission-remote ${TRANSMISSION_HOST:-192.168.2.100}:${TRANSMISSION_PORT:-9091}"
# With auth (if set):
[ -n "$TRANSMISSION_USER" ] && TR="$TR --auth ${TRANSMISSION_USER}:${TRANSMISSION_PASS}"
```

---

## Add a torrent file

```bash
$TR --add /workspace/group/media/filename.torrent 2>&1
```

Success output: `"filename.torrent" added with id N`
Error `403: Forbidden — Unauthorized IP Address` → Transmission's rpc-whitelist blocks the container IP.
Tell the user: "Transmission заблокировал запрос (403). Нужно в settings.json поставить `rpc-whitelist-enabled: false` и перезапустить transmission-daemon."

---

## List all torrents

```bash
$TR --list
```

Output columns: `ID  Done  Have  ETA  Up  Down  Ratio  Status  Name`

---

## Check a specific torrent

```bash
$TR --torrent N --info
```

---

## Remove a torrent (keep files)

```bash
$TR --torrent N --remove
```

## Remove a torrent (delete files)

```bash
$TR --torrent N --remove-and-delete
```

---

## Typical flow after rutracker download

1. Run rutracker download script → get `.torrent` path
2. Add to transmission:
   ```bash
   TR="transmission-remote ${TRANSMISSION_HOST:-192.168.2.100}:${TRANSMISSION_PORT:-9091}"
   [ -n "$TRANSMISSION_USER" ] && TR="$TR --auth ${TRANSMISSION_USER}:${TRANSMISSION_PASS}"
   $TR --add /workspace/group/media/filename.torrent
   ```
3. Confirm to user: "Добавил в Transmission: Название (ID N)"

---

## If connection refused

Check that Transmission is running: `$TR --list` should return a list.
If it fails — report to user: "Transmission недоступен по адресу ${TRANSMISSION_HOST:-192.168.2.100}:${TRANSMISSION_PORT:-9091}"
