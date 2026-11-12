"""Atlas local news reader. Python 3.10+, standard library only."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import threading
import time
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen
import webbrowser
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
FEED_TIMEOUT = 5
SEARCH_TIMEOUT = 7
CACHE_SECONDS = 300
MAX_FEED_BYTES = 2 * 1024 * 1024
FEED_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="atlas-feed")
CACHE: dict[str, tuple[float, dict]] = {}
CACHE_LOCK = threading.Lock()
COUNTRY_TERMS = {
    "United States": ["United States", "USA"],
    "United Kingdom": ["United Kingdom", "Britain"],
    "Ivory Coast": ["Ivory Coast", "Cote d Ivoire"],
    "Côte d’Ivoire": ["Ivory Coast", "Cote d Ivoire"],
    "Czech Republic": ["Czech Republic", "Czechia"],
    "Turkey": ["Turkey", "Turkiye"],
    "Bosnia and Herz.": ["Bosnia and Herzegovina", "Bosnia"],
    "Central African Rep.": ["Central African Republic"],
    "Dem. Rep. Congo": ["Democratic Republic of the Congo", "DR Congo"],
    "Democratic Republic of the Congo": ["Democratic Republic of the Congo", "DR Congo"],
    "Congo": ["Republic of the Congo", "Congo Brazzaville"],
    "Republic of the Congo": ["Republic of the Congo", "Congo Brazzaville"],
    "Dominican Rep.": ["Dominican Republic"],
    "Eq. Guinea": ["Equatorial Guinea"],
    "eSwatini": ["Eswatini", "Swaziland"],
    "Falkland Is.": ["Falkland Islands"],
    "Fr. S. Antarctic Lands": ["French Southern and Antarctic Lands"],
    "N. Cyprus": ["Northern Cyprus"],
    "S. Sudan": ["South Sudan"],
    "Solomon Is.": ["Solomon Islands"],
    "W. Sahara": ["Western Sahara"],
    "East Timor": ["East Timor", "Timor Leste"],
    "Macedonia": ["North Macedonia"],
}


def country_query(country: str) -> str:
    if not country or len(country) > 80 or not all(
        char.isalpha() or char in " .’'-&()" for char in country
    ):
        raise ValueError("Choose a valid country.")
    if country == "Georgia":
        return '"Georgia" ("Tbilisi" OR "Georgian" OR "Caucasus")'
    names = COUNTRY_TERMS.get(country, [country])
    quoted = [f'"{name}"' for name in names]
    return "(" + " OR ".join(quoted) + ")" if len(quoted) > 1 else quoted[0]


def safe_url(value: str | None) -> str:
    try:
        parsed = urlparse(value or "")
        if parsed.scheme not in ("https", "http") or not parsed.hostname or parsed.username or parsed.password:
            return ""
        return parsed.geturl()
    except ValueError:
        return ""


def child_text(item: ET.Element, local_name: str) -> str:
    for child in item:
        if child.tag.rsplit("}", 1)[-1] == local_name:
            return (child.text or "").strip()
    return ""


def parse_feed(payload: bytes, provider: str) -> list[dict]:
    root = ET.fromstring(payload)
    if root.tag != "rss" or root.find("channel") is None:
        raise ValueError("The news provider did not return an RSS feed.")
    articles = []
    cutoff = datetime.now(timezone.utc) - timedelta(days=7)
    for item in root.findall("./channel/item"):
        title = child_text(item, "title")
        link = safe_url(child_text(item, "link"))
        if not title or not link:
            continue
        # Bing supplies the original article URL inside its click-through link.
        parsed_link = urlparse(link)
        if parsed_link.hostname in ("bing.com", "www.bing.com"):
            original = parse_qs(parsed_link.query).get("url", [""])[0]
            link = safe_url(original) or link
        source = child_text(item, "Source") or child_text(item, "source") or urlparse(link).hostname
        if provider == "Google News" and title.endswith(" - " + source):
            title = title[: -(len(source) + 3)]
        published = None
        try:
            published = parsedate_to_datetime(child_text(item, "pubDate"))
            if published.tzinfo is None:
                published = published.replace(tzinfo=timezone.utc)
            if published < cutoff:
                continue
        except (TypeError, ValueError, OverflowError):
            pass
        image = safe_url(child_text(item, "Image"))
        if image and urlparse(image).hostname in ("www.bing.com", "bing.com"):
            image = urlunparse(urlparse(image)._replace(scheme="https"))
        articles.append({
            "title": title, "url": link, "source": source, "image": image,
            "publishedAt": published.isoformat() if published else None,
            "provider": provider,
        })
    return articles


def fetch_feed(url: str, provider: str) -> list[dict]:
    request = Request(url, headers={"User-Agent": "Mozilla/5.0 AtlasPersonalNewsReader/1.0"})
    with urlopen(request, timeout=FEED_TIMEOUT) as response:
        payload = response.read(MAX_FEED_BYTES + 1)
    if len(payload) > MAX_FEED_BYTES:
        raise ValueError("News feed is too large.")
    return parse_feed(payload, provider)


def merge_articles(groups: list[list[dict]]) -> list[dict]:
    result, titles, urls = [], set(), set()
    for articles in groups:
        for article in articles:
            title_key = re.sub(r"[\W_]+", "", article["title"].casefold())
            parsed = urlparse(article["url"])
            params = {key: value for key, value in parse_qs(parsed.query).items()
                      if not key.lower().startswith("utm_") and key.lower() not in ("fbclid", "gclid")}
            url_key = urlunparse(parsed._replace(query=urlencode(params, doseq=True), fragment=""))
            if title_key in titles or url_key in urls:
                continue
            titles.add(title_key)
            urls.add(url_key)
            result.append(article)
            if len(result) == 20:
                return result
    return result


def get_news(country: str) -> dict:
    query = country_query(country)
    with CACHE_LOCK:
        cached = CACHE.get(country)
    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        return cached[1]
    feeds = [
        ("Bing News", "https://www.bing.com/news/search?" + urlencode({
            "q": query, "format": "rss", "count": 30, "mkt": "en-US",
        })),
        ("Google News", "https://news.google.com/rss/search?" + urlencode({
            "q": query + " when:7d", "hl": "en-US", "gl": "US", "ceid": "US:en",
        })),
    ]
    jobs = [(name, FEED_POOL.submit(fetch_feed, url, name)) for name, url in feeds]
    done, pending = wait([future for _, future in jobs], timeout=SEARCH_TIMEOUT)
    for future in pending:
        future.cancel()
    groups, providers = [], []
    for name, future in jobs:
        if future in done:
            try:
                articles = future.result()
                groups.append(articles)
                if articles:
                    providers.append(name)
            except Exception as error:
                print(f"{name} feed unavailable: {error}", flush=True)
    if not groups:
        raise RuntimeError("News sources did not respond in time. Please retry in a moment.")
    result = {
        "country": country, "articles": merge_articles(groups),
        "fetchedAt": int(time.time() * 1000),
        "provider": " + ".join(providers) or "News feeds", "coverageDays": 7,
    }
    if result["articles"]:
        with CACHE_LOCK:
            if len(CACHE) >= 250:
                CACHE.clear()
            CACHE[country] = (time.monotonic(), result)
    return result


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        origin = self.headers.get("Origin", "")
        if urlparse(self.path).path.startswith("/api/") and self.allowed_origin(origin):
            # Local files use Origin: null; local preview servers use their own port.
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        super().end_headers()

    @staticmethod
    def allowed_origin(origin: str) -> bool:
        if origin == "null":
            return True
        try:
            parsed = urlparse(origin)
            return parsed.scheme in ("http", "https") and parsed.hostname in ("localhost", "127.0.0.1", "::1")
        except ValueError:
            return False

    def do_OPTIONS(self):
        if not urlparse(self.path).path.startswith("/api/") or not self.allowed_origin(self.headers.get("Origin", "")):
            self.send_error(403)
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def send_json(self, status: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # The reader switched countries or closed the panel.

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json(200, {"app": "atlas-world-news", "status": "ok"})
        elif parsed.path == "/api/news":
            country = parse_qs(parsed.query).get("country", [""])[0].strip()
            try:
                self.send_json(200, get_news(country))
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            except Exception as error:
                print(f"News search failed for {country!r}: {error}", flush=True)
                self.send_json(503, {"error": "News sources did not respond in time. Please retry in a moment."})
        elif parsed.path.startswith("/api/"):
            self.send_json(404, {"error": "Unknown endpoint."})
        elif parsed.path in ("/", "/index.html", "/app.js", "/news.js", "/daylight.js", "/country-times.js", "/styles.css", "/favicon.ico"):
            super().do_GET()
        else:
            self.send_error(404)

    def do_HEAD(self):
        if urlparse(self.path).path in ("/", "/index.html", "/app.js", "/news.js", "/daylight.js", "/country-times.js", "/styles.css"):
            super().do_HEAD()
        else:
            self.send_error(404)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="Open Atlas in your browser")
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        if args.open:
            try:
                with urlopen(f"http://127.0.0.1:{args.port}/api/health", timeout=1) as response:
                    existing = json.load(response)
                if existing.get("app") == "atlas-world-news":
                    print("Atlas is already running. Opening the browser.", flush=True)
                    webbrowser.open(f"http://127.0.0.1:{args.port}")
                    return
            except Exception:
                pass
        parser.exit(1, f"Could not start Atlas on port {args.port}: {error}\n")
    print(f"Atlas is ready at http://127.0.0.1:{args.port}\nPress Ctrl+C to stop.", flush=True)
    if args.open:
        webbrowser.open(f"http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        FEED_POOL.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
