"""Harvest BaniDB - the database that powers SikhiToTheMax.

BaniDB publishes no SQL dump; its corpus is reachable only through the public
REST API at api.banidb.com/v2. So we walk the API exhaustively and keep every
raw response on disk, gzipped, one file per request. That cache *is* the
downloaded dataset: re-running any stage is free and offline, and a run killed
half way resumes exactly where it stopped.

Coverage strategy, per source:

* ``G D B S`` are paginated by ang, so we walk every ang.
* ``R`` (codes of conduct) has its own chapter endpoints.
* ``A`` (Amrit Keertan) publishes a single 2,675-entry index.
* ``N`` (Bhai Nand Lal) is neither - its shabads sit in a sparse band of the
  shabad-ID space, which `scan_shabads` finds with a coarse sweep followed by
  a dense fill around each hit.
"""
from __future__ import annotations

import json
from typing import Iterable

from .. import config
from ..net import Fetcher, Job

RANGES_FILE = config.RAW_BANIDB / "shabad_ranges.json"


def make_fetcher() -> Fetcher:
    return Fetcher(
        base_url=config.BANIDB_BASE,
        cache_dir=config.RAW_BANIDB,
        rps=config.BANIDB_RPS,
        user_agent=config.USER_AGENT,
        workers=config.BANIDB_WORKERS,
    )


# --- stages ----------------------------------------------------------------
def fetch_metadata(f: Fetcher, force: bool = False) -> None:
    """Sources, writers and raags: three small reference tables."""
    jobs = [Job(path=n, key=f"meta/{n}") for n in ("sources", "writers", "raags")]
    f.run(jobs, "metadata", force=force)


def fetch_angs(f: Fetcher, force: bool = False) -> None:
    """Every ang of every ang-paginated source: the bulk of the corpus."""
    for sid, info in config.ANG_SOURCES.items():
        jobs = [
            Job(path=f"angs/{n}/{sid}", key=f"angs/{sid}/{n:04d}", meta={"ang": n})
            for n in range(1, info["angs"] + 1)
        ]
        f.run(jobs, f"angs {sid} ({info['name'][:18]})", force=force)


def fetch_banis(f: Fetcher, force: bool = False) -> None:
    """The nitnem banis, each with its verses and per-maryada inclusion flags."""
    listing = f.fetch(Job(path="banis", key="banis/_index"), force=force).data or []
    ids = [b["ID"] for b in listing if "ID" in b]
    jobs = [Job(path=f"banis/{i}", key=f"banis/{i:03d}") for i in ids]
    f.run(jobs, f"banis ({len(ids)})", force=force)


def fetch_amritkeertan(f: Fetcher, force: bool = False) -> None:
    """Amrit Keertan: one index call, then each of its section headers."""
    f.fetch(Job(path="amritkeertan", key="amritkeertan/_headers"), force=force)
    idx = f.fetch(Job(path="amritkeertan/index", key="amritkeertan/_index"),
                  force=force).data or {}
    header_ids = sorted({
        row["HeaderID"] for row in idx.get("index", []) if row.get("HeaderID")
    })
    jobs = [
        Job(path=f"amritkeertan/index/{h}", key=f"amritkeertan/header/{h:04d}")
        for h in header_ids
    ]
    f.run(jobs, f"amrit keertan ({len(header_ids)})", force=force)


def fetch_rehats(f: Fetcher, force: bool = False) -> None:
    """Codes of conduct: maryada -> chapters -> chapter contents."""
    listing = f.fetch(Job(path="rehats", key="rehats/_index"), force=force).data or {}
    rehat_ids = [m["rehatID"] for m in listing.get("maryadas", [])]
    chapter_jobs: list[Job] = []
    for rid in rehat_ids:
        res = f.fetch(Job(path=f"rehats/{rid}", key=f"rehats/{rid}/_chapters"),
                      force=force)
        for ch in (res.data or {}).get("chapters", []):
            cid = ch["chapterID"]
            chapter_jobs.append(
                Job(path=f"rehats/{rid}/chapters/{cid}",
                    key=f"rehats/{rid}/chapter/{cid:04d}")
            )
    f.run(chapter_jobs, f"rehat chapters ({len(chapter_jobs)})", force=force)


def scan_shabads(f: Fetcher, force: bool = False) -> dict:
    """Find and fetch shabads for sources that are not paginated by ang.

    A coarse sweep every `SHABAD_SCAN_STRIDE` ids locates the populated bands;
    each hit is then filled in densely outwards until the band runs dry. This
    costs a few thousand requests instead of scanning 46,000 ids blindly.
    """
    stride = config.SHABAD_SCAN_STRIDE
    probes = list(range(1, config.SHABAD_SCAN_MAX + 1, stride))
    # Ids already covered by the ang walk are skipped - we only want the gaps.
    known = _ang_shabad_ids()
    probes = [i for i in probes if i not in known]

    hits: set[int] = set()

    def note(res) -> None:
        if res.data and res.data.get("verses"):
            hits.add(int(res.job.meta["id"]))

    f.run(
        [Job(path=f"shabads/{i}", key=f"shabads/{i:06d}", meta={"id": i})
         for i in probes],
        f"shabad sweep (stride {stride})", force=force, on_result=note,
    )

    # Densify: around every hit, walk outwards until `stride` consecutive
    # misses, so a band is followed to its true edges.
    frontier = sorted(hits)
    seen: set[int] = set(probes)
    band: set[int] = set()
    for h in frontier:
        band.update(range(max(1, h - stride), min(config.SHABAD_SCAN_MAX, h + stride) + 1))
    todo = sorted(band - seen - known)

    found: set[int] = set(hits)

    def note2(res) -> None:
        if res.data and res.data.get("verses"):
            found.add(int(res.job.meta["id"]))

    f.run(
        [Job(path=f"shabads/{i}", key=f"shabads/{i:06d}", meta={"id": i})
         for i in todo],
        f"shabad fill ({len(todo)})", force=force, on_result=note2,
    )

    ranges = _to_ranges(sorted(found))
    RANGES_FILE.write_text(
        json.dumps({"stride": stride, "found": len(found), "ranges": ranges}, indent=2)
    )
    print(f"  discovered {len(found)} shabads in {len(ranges)} band(s): {ranges}")
    return {"found": sorted(found), "ranges": ranges}


def fetch_shabad_meta(f: Fetcher, ids: Iterable[int], force: bool = False) -> None:
    """Shabad-level records (title, raag, writer) for the given shabad ids."""
    ids = sorted(set(int(i) for i in ids))
    jobs = [Job(path=f"shabads/{i}", key=f"shabads/{i:06d}", meta={"id": i})
            for i in ids]
    f.run(jobs, f"shabads ({len(jobs)})", force=force)


# --- helpers ---------------------------------------------------------------
def _ang_shabad_ids() -> set[int]:
    """Shabad ids already visible in the cached ang responses."""
    from ..net import iter_cached

    out: set[int] = set()
    for _key, data in iter_cached(config.RAW_BANIDB, "angs"):
        for verse in data.get("page", []) or []:
            if verse.get("shabadId"):
                out.add(int(verse["shabadId"]))
    return out


def _to_ranges(nums: list[int]) -> list[list[int]]:
    """Collapse a sorted id list into [start, end] bands for the manifest."""
    if not nums:
        return []
    out = [[nums[0], nums[0]]]
    for n in nums[1:]:
        if n <= out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return out


STAGES = {
    "metadata": fetch_metadata,
    "angs": fetch_angs,
    "banis": fetch_banis,
    "amritkeertan": fetch_amritkeertan,
    "rehats": fetch_rehats,
    "shabad-scan": scan_shabads,
}
