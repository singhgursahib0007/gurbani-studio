"""A polite, resumable HTTP/JSON fetcher.

Three properties matter for this harness, and each is deliberate:

* **Polite** - a shared token bucket keeps us under the API's published rate
  limit no matter how many worker threads are running, and 429/5xx responses
  back off exponentially with jitter rather than hammering.
* **Resumable** - every response is written to a gzipped file on disk keyed by
  its logical path. Re-running a fetch is free and offline; a run interrupted
  at ang 900 picks up at ang 900.
* **Honest** - a fetch either yields parsed JSON or records a durable error.
  Nothing is silently skipped, and `errors` is reported at the end of a run.
"""
from __future__ import annotations

import gzip
import json
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence


class RateLimiter:
    """Thread-safe token bucket: at most `rps` requests per second overall."""

    def __init__(self, rps: float, burst: float | None = None) -> None:
        self.rps = rps
        self.capacity = burst if burst is not None else max(1.0, rps)
        self._tokens = self.capacity
        self._last = time.monotonic()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                self._tokens = min(
                    self.capacity, self._tokens + (now - self._last) * self.rps
                )
                self._last = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                wait = (1.0 - self._tokens) / self.rps
            time.sleep(wait)


class Progress:
    """A single-line stderr progress bar. Quiet when not a TTY."""

    def __init__(self, total: int, label: str) -> None:
        self.total, self.label = total, label
        self.n = 0
        self.hits = 0
        self.start = time.monotonic()
        self._lock = threading.Lock()
        self._tty = sys.stderr.isatty()

    def tick(self, cached: bool = False) -> None:
        with self._lock:
            self.n += 1
            self.hits += int(cached)
            if not self._tty:
                return
            if self.n % 5 and self.n != self.total:
                return
            self._draw()

    def _draw(self) -> None:
        frac = self.n / self.total if self.total else 1.0
        width = 28
        done = int(frac * width)
        elapsed = time.monotonic() - self.start
        rate = self.n / elapsed if elapsed > 0.5 else 0.0
        eta = (self.total - self.n) / rate if rate > 0 else 0.0
        bar = "#" * done + "." * (width - done)
        sys.stderr.write(
            f"\r  {self.label:<22} [{bar}] {self.n}/{self.total}"
            f"  {rate:5.1f}/s  eta {_hms(eta)}  cached:{self.hits}   "
        )
        sys.stderr.flush()

    def close(self) -> None:
        if self._tty:
            self._draw()
            sys.stderr.write("\n")
        else:
            el = time.monotonic() - self.start
            print(
                f"  {self.label}: {self.n}/{self.total} in {_hms(el)} "
                f"({self.hits} cached)"
            )


def _hms(seconds: float) -> str:
    seconds = int(max(0, seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}h{m:02d}m" if h else f"{m}m{s:02d}s"


@dataclass
class Job:
    """One logical fetch: a URL path and the cache key it is stored under."""

    path: str          # appended to the fetcher's base URL
    key: str           # cache key, e.g. "angs/G/0001"
    meta: dict = field(default_factory=dict)


@dataclass
class Result:
    job: Job
    data: Any | None
    cached: bool
    error: str | None = None


class Fetcher:
    """Fetches JSON with an on-disk gzip cache."""

    def __init__(
        self,
        base_url: str,
        cache_dir: Path,
        rps: float,
        user_agent: str,
        workers: int = 4,
        timeout: int = 45,
        retries: int = 5,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.cache_dir = Path(cache_dir)
        self.limiter = RateLimiter(rps)
        self.user_agent = user_agent
        self.workers = workers
        self.timeout = timeout
        self.retries = retries
        self.errors: list[tuple[str, str]] = []
        self._errlock = threading.Lock()

    # -- cache -------------------------------------------------------------
    def cache_path(self, key: str) -> Path:
        return self.cache_dir / f"{key}.json.gz"

    def load_cached(self, key: str) -> Any | None:
        p = self.cache_path(key)
        if not p.exists():
            return None
        try:
            with gzip.open(p, "rt", encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, EOFError, json.JSONDecodeError):
            p.unlink(missing_ok=True)   # corrupt (e.g. killed mid-write): refetch
            return None

    def _store(self, key: str, data: Any) -> None:
        p = self.cache_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        tmp.replace(p)   # atomic: a cache file is never half-written

    # -- fetching ----------------------------------------------------------
    def _http_json(self, path: str) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        last: Exception | None = None
        for attempt in range(self.retries):
            self.limiter.acquire()
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": self.user_agent,
                                  "Accept": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    raise                      # a real "not there": don't retry
                last = exc
                retry_after = exc.headers.get("Retry-After") if exc.headers else None
                delay = float(retry_after) if retry_after and retry_after.isdigit() \
                    else 2.0 ** attempt
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError,
                    ConnectionError) as exc:
                last = exc
                delay = 2.0 ** attempt
            time.sleep(delay + random.uniform(0, 0.5))
        raise last if last else RuntimeError(f"failed: {url}")

    def fetch(self, job: Job, force: bool = False) -> Result:
        if not force:
            cached = self.load_cached(job.key)
            if cached is not None:
                return Result(job, cached, cached=True)
        try:
            data = self._http_json(job.path)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return Result(job, None, cached=False, error="404")
            msg = f"HTTP {exc.code}"
            with self._errlock:
                self.errors.append((job.key, msg))
            return Result(job, None, cached=False, error=msg)
        except Exception as exc:                       # noqa: BLE001
            msg = f"{type(exc).__name__}: {exc}"
            with self._errlock:
                self.errors.append((job.key, msg))
            return Result(job, None, cached=False, error=msg)
        self._store(job.key, data)
        return Result(job, data, cached=False)

    def run(
        self,
        jobs: Sequence[Job],
        label: str,
        force: bool = False,
        on_result: Callable[[Result], None] | None = None,
    ) -> list[Result]:
        """Fetch every job, in parallel, with a progress bar."""
        if not jobs:
            return []
        bar = Progress(len(jobs), label)
        out: list[Result] = []
        lock = threading.Lock()

        def work(job: Job) -> None:
            res = self.fetch(job, force=force)
            bar.tick(cached=res.cached)
            with lock:
                out.append(res)
                if on_result:
                    on_result(res)

        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            list(pool.map(work, jobs))
        bar.close()
        return out


def iter_cached(cache_dir: Path, subdir: str) -> Iterable[tuple[str, Any]]:
    """Yield (key, data) for every cached response under `subdir`, sorted."""
    base = Path(cache_dir) / subdir
    if not base.exists():
        return
    for p in sorted(base.rglob("*.json.gz")):
        key = str(p.relative_to(cache_dir)).removesuffix(".json.gz")
        try:
            with gzip.open(p, "rt", encoding="utf-8") as fh:
                yield key, json.load(fh)
        except (OSError, EOFError, json.JSONDecodeError):
            continue
