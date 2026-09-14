#!/usr/bin/env python

from argparse import ArgumentParser
from configparser import ConfigParser
from datetime import datetime, timedelta, timezone
from json import dumps, loads
from os import environ
from pathlib import Path
from sys import stderr
from time import sleep
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

PER_PAGE = 100
VIEW_SEGMENT = "/w/"


def get_config(config_path: Path = Path("./.github/config.ini")) -> dict[str, str]:
    parser = ConfigParser()
    parser.read_string(config_path.read_text())
    config = dict(parser.defaults())
    if parser.has_section("site"):
        config.update(dict(parser.items("site")))
    return config


def fetch_page(api: str, token: str, query: dict) -> dict:
    url = f"https://{api}/api/v0/stats/hits?{urlencode(query, doseq=True)}"
    request = Request(url, headers={
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "walls-statsgen",
        "Authorization": f"Bearer {token}",
    })
    with urlopen(request, timeout=60) as response:
        return loads(response.read())


def tracked_paths(manifest_path: Path, prefix: str) -> dict[str, str]:
    manifest = loads(manifest_path.read_text())
    tracked: dict[str, str] = {}
    for category in manifest.get("categories", []):
        for file in category.get("files", []):
            path = file.get("path")
            if path:
                tracked[f"{prefix}{VIEW_SEGMENT}{path}".lower()] = path
    return tracked


def previous_stats(site_url: str) -> dict | None:
    url = f"{site_url.rstrip('/')}/stats.json"
    try:
        request = Request(url, headers={"User-Agent": "walls-statsgen"})
        with urlopen(request, timeout=30) as response:
            data = loads(response.read())
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def restore_previous(out: Path, site_url: str, dry: bool = False) -> None:
    if dry:
        return
    if out.exists() and out.read_text().strip() not in ("", "{}"):
        return
    if not site_url:
        return
    stats = previous_stats(site_url)
    if stats is None:
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dumps(stats, indent=2, sort_keys=True) + "\n")
    print(f"statsgen: restored {out} from {site_url}", file=stderr)


def main() -> None:
    parser = ArgumentParser(description="Aggregate GoatCounter visits into site/stats.json.")
    parser.add_argument("--out", default=None)
    parser.add_argument("--config", default=".github/config.ini")
    parser.add_argument("--dry", action="store_true")
    arguments = parser.parse_args()

    config = get_config(Path(arguments.config))
    out = Path(arguments.out) if arguments.out else Path(config.get("manifest", "site/manifest.json")).with_name("stats.json")
    site_url = config.get("site_url", "").strip()
    token = environ.get("GOATCOUNTER_TOKEN")
    api = config.get("goatcounter", "").strip().rstrip("/")
    if not api or not token:
        print("statsgen: GOATCOUNTER_TOKEN or goatcounter site missing; keeping existing stats", file=stderr)
        restore_previous(out, site_url, arguments.dry)
        return

    prefix = config.get("stats_prefix", "/walls").rstrip("/")
    days = int(config.get("stats_days", "14"))
    top_n = int(config.get("stats_top", "60"))
    batch_size = max(1, int(config.get("stats_batch", "40")))
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
    start = (datetime.now(timezone.utc) - timedelta(days=days)).replace(minute=0, second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")

    manifest_path = Path(config.get("manifest", "site/manifest.json"))
    try:
        tracked = tracked_paths(manifest_path, prefix)
    except Exception as error:
        print(f"statsgen: cannot read manifest {manifest_path}: {error}; keeping existing stats", file=stderr)
        restore_previous(out, site_url, arguments.dry)
        return

    stats: dict[str, int] = {}
    names = list(tracked)
    try:
        for index in range(0, len(names), batch_size):
            query = {
                "start": start,
                "end": end,
                "limit": str(PER_PAGE),
                "path_by_name": "true",
                "include_paths": names[index:index + batch_size],
            }
            data = fetch_page(api, token, query)
            for hit in data.get("hits", []):
                if hit.get("event"):
                    continue
                path = tracked.get((hit.get("path") or "").lower())
                count = int(hit.get("count") or 0)
                if path and count > 0:
                    stats[path] = max(stats.get(path, 0), count)
            if index + batch_size < len(names):
                sleep(0.3)
    except HTTPError as error:
        body = error.read().decode("utf-8", "replace").strip()
        print(f"statsgen: GoatCounter API returned HTTP {error.code} for {error.url}: {body}; keeping existing stats", file=stderr)
        restore_previous(out, site_url, arguments.dry)
        return
    except Exception as error:
        print(f"statsgen: {error}; keeping existing stats", file=stderr)
        restore_previous(out, site_url, arguments.dry)
        return

    stats = dict(sorted(stats.items(), key=lambda item: item[1], reverse=True)[:top_n])

    if arguments.dry:
        print(dumps(stats, indent=2))
        return
    if not stats and tracked:
        restore_previous(out, site_url, arguments.dry)
        print(f"statsgen: no visits for {len(tracked)} tracked paths; keeping existing stats", file=stderr)
        return
    out.write_text(dumps(stats, indent=2, sort_keys=True) + "\n")
    print(f"statsgen: wrote {out} (top {len(stats)} wallpapers with visits, window {start}..{end}, {len(tracked)} paths tracked)")


if __name__ == "__main__":
    main()
