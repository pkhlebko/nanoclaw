#!/usr/bin/env python3
"""Download a book from Flibusta.
Usage: download.py <dl_href> <author> <title>
Example: download.py /b/150709/fb2 "Булгаков" "Мастер и Маргарита"
Prints: OK: /workspace/group/media/Author_Title.fb2
     or ERROR: message
"""
import sys
import os
import re
import zipfile
import urllib.request
import urllib.error

DOMAINS = ["flibusta.is", "flibusta.app", "flibusta.net"]
UA = "Mozilla/5.0 (compatible; FlibustaBot/1.0)"
MEDIA_DIR = "/workspace/group/media"


def find_base():
    for domain in DOMAINS:
        url = "http://{}/opds".format(domain)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=8) as r:
                if r.status == 200:
                    return "http://{}".format(domain)
        except Exception:
            pass
    return None


def safe_name(s):
    # Keep cyrillic, latin, digits, spaces -> underscores
    s = re.sub(r"[^\w\s\u0400-\u04FF-]", "", s)
    s = re.sub(r"\s+", "_", s.strip())
    return s[:60]


def download_fb2(base, dl_href, author, title):
    url = "{}{}".format(base, dl_href)
    os.makedirs(MEDIA_DIR, exist_ok=True)
    tmp_path = os.path.join(MEDIA_DIR, "_flibusta_tmp.zip")

    # Download
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            content = r.read()
    except urllib.error.URLError as e:
        return None, "Download error: {}".format(e)

    # Detect HTML error page (Flibusta returns HTTP 200 even for errors)
    if content[:100].strip().startswith(b"<!") or b"No file found" in content[:500]:
        snippet = content[:200].decode("utf-8", errors="replace")
        return None, "Server returned error page: {}".format(snippet[:100])

    if len(content) < 512:
        return None, "File too small ({} bytes) — likely an error".format(len(content))

    final_name = "{}_{}.fb2".format(safe_name(author), safe_name(title))
    final_path = os.path.join(MEDIA_DIR, final_name)

    # Try unzip
    with open(tmp_path, "wb") as f:
        f.write(content)

    try:
        with zipfile.ZipFile(tmp_path) as z:
            fb2_files = [n for n in z.namelist() if n.endswith(".fb2")]
            if not fb2_files:
                # Use first file anyway
                fb2_files = z.namelist()[:1]
            if not fb2_files:
                return None, "Empty archive"
            z.extract(fb2_files[0], MEDIA_DIR)
            extracted = os.path.join(MEDIA_DIR, fb2_files[0])
            os.rename(extracted, final_path)
        os.remove(tmp_path)
    except zipfile.BadZipFile:
        # Some books are delivered as plain fb2 without zip
        os.rename(tmp_path, final_path)

    return final_path, None


def main():
    if len(sys.argv) < 4:
        print("Usage: download.py <dl_href> <author> <title>", file=sys.stderr)
        sys.exit(1)

    dl_href = sys.argv[1]
    author = sys.argv[2]
    title = sys.argv[3]

    if not dl_href.startswith("/b/"):
        print("ERROR: invalid dl_href: {}".format(dl_href))
        sys.exit(1)

    base = find_base()
    if not base:
        print("ERROR: Flibusta unreachable")
        sys.exit(1)

    path, err = download_fb2(base, dl_href, author, title)
    if err:
        print("ERROR: {}".format(err))
        sys.exit(1)

    print("OK: {}".format(path))


if __name__ == "__main__":
    main()
