"""Central configuration: paths, source registry, provenance.

Everything the harness knows about *where* data comes from lives here, so a
future contributor can add a source without touching fetch/build logic.
"""
from __future__ import annotations

from pathlib import Path

# --- Paths -----------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
PROCESSED = DATA / "processed"
EXPORTS = DATA / "exports"

RAW_BANIDB = RAW / "banidb"
RAW_SHABADOS = RAW / "shabados"
DB_PATH = PROCESSED / "gurbani.sqlite"

for _p in (RAW_BANIDB, RAW_SHABADOS, PROCESSED, EXPORTS):
    _p.mkdir(parents=True, exist_ok=True)

# --- BaniDB (the database behind SikhiToTheMax) ----------------------------
BANIDB_BASE = "https://api.banidb.com/v2"

# The API rate-limits to 250 req/min per IP (api/controllers/limiter.js).
# We stay well under that: 4 req/s = 240/min, with 4 workers.
BANIDB_RPS = 4.0
BANIDB_WORKERS = 4

USER_AGENT = (
    "GurbaniSearch/1.0 (local research + study archive; "
    "polite harvester, honours rate limits)"
)

# Sources that are paginated by ang (page). Page counts verified by probing
# the API: requesting beyond the last ang clamps to the last ang.
ANG_SOURCES = {
    "G": {"name": "Sri Guru Granth Sahib Ji", "angs": 1430},
    "D": {"name": "Dasam Bani", "angs": 1428},
    "B": {"name": "Bhai Gurdas Ji Vaaran", "angs": 40},
    "S": {"name": "Bhai Gurdas Singh Ji Vaaran", "angs": 28},
}

# Sources NOT paginated by ang. Their shabads live in sparse ID bands, which
# `fetch banidb --what shabad-scan` discovers and records in shabad_ranges.json.
NON_ANG_SOURCES = ("A", "N", "R")

# Coarse sweep bounds for discovering those bands.
SHABAD_SCAN_MAX = 46000
SHABAD_SCAN_STRIDE = 25

# --- Shabad OS (independent scholarly corpus, direct SQLite download) ------
SHABADOS_RELEASE = "v5.0.0-next.0"
SHABADOS_ASSETS = {
    "master.sqlite": (
        "https://github.com/shabados/database/releases/download/"
        f"{SHABADOS_RELEASE}/master.sqlite"
    ),
}

# --- Provenance shown in the UI and written into the DB --------------------
PROVENANCE = {
    "banidb": {
        "title": "BaniDB",
        "steward": "Khalis Foundation",
        "powers": "SikhiToTheMax (web, desktop, mobile)",
        "api": BANIDB_BASE,
        "repo": "https://github.com/KhalisFoundation/banidb-api",
        "notes": (
            "Standardised for lagamatra and padh chhedh against SGPC pothis; "
            "43,000+ community-vetted corrections."
        ),
    },
    "shabados": {
        "title": "Shabad OS Database",
        "steward": "Shabad OS",
        "release": SHABADOS_RELEASE,
        "repo": "https://github.com/shabados/database",
        "notes": (
            "Every line traced to a cited printed source, with a public "
            "logbook of sangat-sourced corrections. Archived 2026-08-22; "
            "development continues in the shabados/shabados monorepo."
        ),
    },
}
