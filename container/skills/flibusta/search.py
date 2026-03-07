#!/usr/bin/env python3
"""Search Flibusta OPDS for books. Usage: search.py <query>"""
import sys
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

DOMAINS = ["flibusta.is", "flibusta.app", "flibusta.net"]
ATOM = "{http://www.w3.org/2005/Atom}"
UA = "Mozilla/5.0 (compatible; FlibustaBot/1.0)"


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


def search_books(base, query):
    encoded = urllib.parse.quote(query)
    url = "{}/opds/search?searchType=books&searchTerm={}".format(base, encoded)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()

    root = ET.fromstring(data)
    books = []

    for entry in root.findall("{}entry".format(ATOM)):
        title = (entry.findtext("{}title".format(ATOM)) or "").strip()
        authors = [
            a.findtext("{}name".format(ATOM)) or ""
            for a in entry.findall("{}author".format(ATOM))
        ]

        # Find fb2 download link — book_id comes from href, NOT from <id> tag
        # <id> contains a hash like "tag:book:abc123" which is NOT the numeric id
        dl_href = ""
        for link in entry.findall("{}link".format(ATOM)):
            href = link.get("href", "")
            mime = link.get("type", "")
            if "fb2" in mime.lower() and "/b/" in href:
                dl_href = href
                break

        m = re.search(r"/b/(\d+)/", dl_href)
        if not m:
            continue
        book_id = m.group(1)

        books.append({
            "title": title,
            "authors": ", ".join(a for a in authors if a),
            "book_id": book_id,
            "dl": dl_href,
        })

    return books


def main():
    if len(sys.argv) < 2:
        print("Usage: search.py <query>", file=sys.stderr)
        sys.exit(1)

    query = " ".join(sys.argv[1:])

    base = find_base()
    if not base:
        print("ERROR: Flibusta unreachable (tried: {})".format(", ".join(DOMAINS)))
        sys.exit(1)

    books = search_books(base, query)

    if not books:
        print("NOT_FOUND")
        return

    # Write base to stdout for downstream use
    print("BASE={}".format(base))
    for i, b in enumerate(books):
        print("{}. {} — {} [id={}] dl={}".format(
            i + 1, b["title"], b["authors"], b["book_id"], b["dl"]
        ))


if __name__ == "__main__":
    main()
