"""Command line entry point: ``python3 -m harness <command>``."""
from __future__ import annotations

import argparse
import sys
import time

from . import config


def _banner(text: str) -> None:
    print(f"\n\033[1m{text}\033[0m" if sys.stdout.isatty() else f"\n{text}")
    print("-" * max(12, len(text)))


def cmd_fetch(args: argparse.Namespace) -> int:
    from .providers import banidb, shabados

    started = time.monotonic()
    if args.provider in ("shabados", "all"):
        _banner("Shabad OS: release assets")
        shabados.download(force=args.force)

    if args.provider in ("banidb", "all"):
        f = banidb.make_fetcher()
        wanted = (
            list(banidb.STAGES)
            if args.stage in (None, "all")
            else [s.strip() for s in args.stage.split(",")]
        )
        unknown = [s for s in wanted if s not in banidb.STAGES]
        if unknown:
            print(f"unknown stage(s): {unknown}; known: {list(banidb.STAGES)}")
            return 2
        for stage in wanted:
            _banner(f"BaniDB: {stage}")
            banidb.STAGES[stage](f, force=args.force)
        if f.errors:
            print(f"\n{len(f.errors)} request(s) failed; re-run to retry:")
            for key, msg in f.errors[:20]:
                print(f"  {key}: {msg}")
            return 1
    print(f"\nfetch complete in {time.monotonic() - started:.0f}s")
    return 0


def cmd_build(args: argparse.Namespace) -> int:
    from .build import build

    build(rebuild=args.rebuild)
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    from .export import export_all

    export_all(fmt=args.format)
    return 0


def cmd_verify(args: argparse.Namespace) -> int:
    from .verify import verify

    return 0 if verify(online=args.online) else 1


def cmd_static(args: argparse.Namespace) -> int:
    from .static_site import build_static

    _banner("Building the static site")
    from .static_site import DEFAULT_TRANSLATIONS, DEFAULT_TRANSLITS

    build_static(
        out_dir=args.out,
        include_text=not args.no_text,
        translations=tuple(t.strip() for t in args.translations.split(","))
        if args.translations else DEFAULT_TRANSLATIONS,
        translits=tuple(t.strip() for t in args.translits.split(","))
        if args.translits else DEFAULT_TRANSLITS,
    )
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    from app.server import serve

    serve(port=args.port, open_browser=not args.no_open)
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    from .verify import stats

    stats()
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        prog="python3 -m harness",
        description="Build a local Gurbani corpus and search index.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch", help="download raw data into data/raw (resumable)")
    f.add_argument("provider", choices=["banidb", "shabados", "all"], default="all",
                   nargs="?")
    f.add_argument("--stage", help="banidb stages, comma separated, or 'all'")
    f.add_argument("--force", action="store_true", help="ignore the on-disk cache")
    f.set_defaults(func=cmd_fetch)

    b = sub.add_parser("build", help="normalise raw data into data/processed")
    b.add_argument("--rebuild", action="store_true", help="drop and rebuild the DB")
    b.set_defaults(func=cmd_build)

    e = sub.add_parser("export", help="write human-readable exports")
    e.add_argument("--format", default="all", choices=["all", "jsonl", "csv", "txt"])
    e.set_defaults(func=cmd_export)

    v = sub.add_parser("verify", help="run integrity checks on the built database")
    v.add_argument("--online", action="store_true",
                   help="also cross-check local search against the live BaniDB API")
    v.set_defaults(func=cmd_verify)

    s = sub.add_parser("serve", help="run the local search UI")
    s.add_argument("--port", type=int, default=8080)
    s.add_argument("--no-open", action="store_true")
    s.set_defaults(func=cmd_serve)

    ss = sub.add_parser("static",
                        help="emit a serverless site for GitHub Pages / Vercel")
    ss.add_argument("--out", default=None, help="output directory (default: site/)")
    ss.add_argument("--translations",
                    help="comma separated, e.g. en.bdb,pu.ss,en.ms "
                         "(default: those three)")
    ss.add_argument("--translits", help="comma separated: en,hi,ipa,ur")
    ss.add_argument("--no-text", action="store_true",
                    help="omit the lazy English/transliteration search tier")
    ss.set_defaults(func=cmd_static)

    st = sub.add_parser("stats", help="print corpus statistics")
    st.set_defaults(func=cmd_stats)

    args = p.parse_args(argv)
    return args.func(args)
