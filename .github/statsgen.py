#!/usr/bin/env python

from argparse import ArgumentParser
from configparser import ConfigParser
from datetime import datetime, timedelta, timezone
from json import dumps, loads
from os import environ
from pathlib import Path
from sys import stderr
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PER_PAGE = 100
MAX_PAGES = 5
TOP_N = 60
VIEW_SEGMENT = "/w/"


def get_config(config_path: Path = Path("./.github/config.ini")) -> dict[str, str]:
    parser = ConfigParser()
    parser.read_string(config_path.read_text())
    config = dict(parser.defaults())
    if parser.has_section("site"):
        config.update(dict(parser.items("site")))
    return config


def fetch_page(api: str, token: str, start: str, end: str, seen: list[int]) -> dict:
    query = {"start": start, "end": end, "limit": str(PER_PAGE)}
    if seen:
        query["exclude_paths"] = [str(path_id) for path_id in seen]
    url = f"https://{api}/api/v0/stats/hits?{urlencode(query, doseq=True)}"
    request = Request(url, headers={
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "walls-statsgen",
        "Authorization": f"Bearer {token}",
    })
    with urlopen(request, timeout=60) as response:
        return loads(response.read())


def main() -> None:
    parser = ArgumentParser(description="Aggregate GoatCounter pageviews into site/stats.json.")
    parser.add_argument("--out", default=None)
    parser.add_argument("--config", default=".github/config.ini")
    parser.add_argument("--dry", action="store_true")
    arguments = parser.parse_args()

    config = get_config(Path(arguments.config))
    out = Path(arguments.out or config.get("manifest", "site/manifest.json")).with_name("stats.json")
    token = environ.get("GOATCOUNTER_TOKEN")
    api = config.get("goatcounter", "").strip().rstrip("/")
    if not api or not token:
        print("statsgen: GOATCOUNTER_TOKEN or goatcounter site missing; keeping existing stats", file=stderr)
        return

    prefix = config.get("stats_prefix", "/walls").rstrip("/")
    days = int(config.get("stats_days", "14"))
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
    start = (datetime.now(timezone.utc) - timedelta(days=days)).replace(minute=0, second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")

    stats: dict[str, int] = {}
    seen: list[int] = []
    try:
        while len(seen) < MAX_PAGES * PER_PAGE:
            data = fetch_page(api, token, start, end, seen)
            for hit in data.get("hits", []):
                seen.append(hit.get("path_id"))
                path = hit.get("path") or ""
                if path.startswith(f"{prefix}{VIEW_SEGMENT}") and not hit.get("event"):
                    stats[path[len(prefix) + len(VIEW_SEGMENT):]] = hit.get("count", 0)
                    if len(stats) >= TOP_N:
                        break
            if not data.get("more") or len(stats) >= TOP_N:
                break
    except HTTPError as error:
        body = error.read().decode("utf-8", "replace").strip()
        print(f"statsgen: GoatCounter API returned HTTP {error.code} for {error.url}: {body}; keeping existing stats", file=stderr)
        return
    except Exception as error:
        print(f"statsgen: {error}; keeping existing stats", file=stderr)
        return

    stats = dict(sorted(stats.items(), key=lambda item: item[1], reverse=True)[:TOP_N])

    if arguments.dry:
        print(dumps(stats, indent=2))
        return
    out.write_text(dumps(stats, indent=2, sort_keys=True) + "\n")
    print(f"statsgen: wrote {out} (top {len(stats)} wallpapers with views, window {start}..{end}, {len(seen)} paths fetched)")


if __name__ == "__main__":
    main()
