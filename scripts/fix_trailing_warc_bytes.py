# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Trim WARC record terminator bytes accidentally included in scraped .docx files.

Files scraped before commit 477d1b9 contain 4 trailing bytes (\\r\\n\\r\\n)
after the ZIP end-of-central-directory record. The bytes are the WARC record
separator, included by an off-by-4 in the scraper's WARC body extraction.
testzip() tolerates trailing bytes; Word for Mac does not, and shows
"Word found unreadable content" recovery prompts on affected files.

This script repairs already-downloaded copies. Future scrapes are fixed at
the source.

Algorithm (safe by default):
  1. Locate the ZIP EOCD signature (PK\\x05\\x06) by scanning backward from
     end of file (only the last ~64KB are checked, per ZIP spec).
  2. Compute valid_zip_end = EOCD_offset + 22 + comment_len.
  3. Excess = file[valid_zip_end:].
  4. Trim only if excess == b"\\r\\n\\r\\n" exactly. Anything else: skip with
     a "skipped (excess differs)" outcome - we never guess.
  5. Verify the candidate trimmed bytes pass zipfile.testzip() before any
     write. If testzip fails on the candidate, leave the original untouched.
  6. Atomic write: temp file in same dir, fsync, os.replace, fsync parent dir.

Usage:
  uv run scripts/fix_trailing_warc_bytes.py FILE_OR_DIR [...]    # dry run
  uv run scripts/fix_trailing_warc_bytes.py --in-place FILE [...]  # repair
  uv run scripts/fix_trailing_warc_bytes.py --sha256 FILE          # also print
                                                                     # corrected
                                                                     # SHA-256
                                                                     # for trims

Exit codes:
  0 on success (including all-skipped)
  1 on real errors (missing path, permission denied, malformed input given
    explicitly as a single non-ZIP file)
  2 on usage error
"""

from __future__ import annotations

import argparse
import hashlib
import io
import os
import struct
import sys
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

EXPECTED_TAIL = b"\r\n\r\n"
EOCD_SIG = b"PK\x05\x06"
ZIP_MAX_COMMENT = 65535
EOCD_FIXED_LEN = 22


@dataclass
class Outcome:
    path: Path
    status: str  # trimmed | already-clean | skipped-excess-differs |
                 # skipped-no-eocd | skipped-testzip-failed |
                 # skipped-non-zip | skipped-symlink | error
    detail: str = ""
    new_sha256: str | None = None


def find_eocd(data: bytes) -> int:
    """Return the byte offset of the EOCD record, or -1 if not found.

    Scans only the last 22 + 65535 bytes per ZIP spec (max comment size).
    """
    search_start = max(0, len(data) - (EOCD_FIXED_LEN + ZIP_MAX_COMMENT))
    return data.rfind(EOCD_SIG, search_start)


def candidate_trimmed(data: bytes) -> tuple[bytes | None, str]:
    """Return (trimmed_bytes, status). trimmed_bytes is None unless we're
    confident it's safe to write."""
    if len(data) < EOCD_FIXED_LEN + 4:  # too small for any ZIP we care about
        return None, "skipped-non-zip"
    if data[:4] != b"PK\x03\x04" and data[:4] != b"PK\x05\x06":
        return None, "skipped-non-zip"

    eocd = find_eocd(data)
    if eocd < 0:
        return None, "skipped-no-eocd"

    comment_len = struct.unpack_from("<H", data, eocd + 20)[0]
    valid_end = eocd + EOCD_FIXED_LEN + comment_len

    if valid_end > len(data):
        return None, "skipped-no-eocd"  # malformed
    if valid_end == len(data):
        return None, "already-clean"

    excess = data[valid_end:]
    if excess != EXPECTED_TAIL:
        return None, "skipped-excess-differs"

    candidate = data[:valid_end]
    # Verify candidate is still a valid ZIP that opens cleanly
    try:
        with zipfile.ZipFile(io.BytesIO(candidate)) as zf:
            bad = zf.testzip()
            if bad is not None:
                return None, "skipped-testzip-failed"
    except zipfile.BadZipFile:
        return None, "skipped-testzip-failed"

    return candidate, "trimmed"


def atomic_write(path: Path, data: bytes) -> None:
    """Write data to path atomically: temp file + fsync + os.replace + dir fsync."""
    parent = path.parent
    fd, tmp_name = _mkstemp_in(parent, prefix=f".{path.name}.", suffix=".tmp")
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            # Preserve mode of original where possible
            st = path.stat()
            os.chmod(tmp_path, st.st_mode & 0o7777)
        except FileNotFoundError:
            pass
        os.replace(tmp_path, path)
        # Ensure rename is durable
        try:
            dir_fd = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            # Some platforms (Windows) don't support directory fsync
            pass
    except Exception:
        # Best-effort cleanup of temp on failure
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass
        raise


def _mkstemp_in(dir_: Path, prefix: str, suffix: str) -> tuple[int, str]:
    import tempfile
    return tempfile.mkstemp(prefix=prefix, suffix=suffix, dir=str(dir_))


def process_file(path: Path, *, in_place: bool, want_sha: bool) -> Outcome:
    try:
        if path.is_symlink():
            return Outcome(path, "skipped-symlink")
        if not path.is_file():
            return Outcome(path, "skipped-non-zip", "not a regular file")
        with path.open("rb") as fh:
            data = fh.read()
    except OSError as e:
        return Outcome(path, "error", str(e))

    candidate, status = candidate_trimmed(data)

    new_sha = None
    if status == "trimmed" and want_sha and candidate is not None:
        new_sha = hashlib.sha256(candidate).hexdigest()

    if status == "trimmed" and in_place and candidate is not None:
        try:
            atomic_write(path, candidate)
        except OSError as e:
            return Outcome(path, "error", f"write failed: {e}")

    return Outcome(path, status, new_sha256=new_sha)


def iter_inputs(paths: list[Path], *, single_file_strict: bool) -> Iterator[Path]:
    """Yield candidate file paths. Recursive into directories. Skip symlinks.

    If single_file_strict and a single non-existent or non-file path is given
    explicitly, raise; otherwise yield it and let process_file mark it.
    """
    for p in paths:
        if p.is_symlink() and p.is_dir():
            # Don't follow symlinked directories
            continue
        if p.is_dir():
            for entry in p.rglob("*"):
                if entry.is_symlink():
                    continue
                if entry.is_file():
                    yield entry
        else:
            yield p


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=(
            "Trim 4-byte WARC record terminator from .docx files affected by "
            "the pre-477d1b9 scraper bug. Safe by default (dry-run); pass "
            "--in-place to rewrite. Resumable: re-running after Ctrl-C is safe "
            "because already-clean files are detected and skipped."
        )
    )
    ap.add_argument(
        "paths", nargs="+", type=Path,
        help="Files or directories. Directories are traversed recursively. Symlinks are skipped.",
    )
    ap.add_argument("--in-place", action="store_true",
                    help="Actually rewrite affected files. Without this flag, runs as dry-run.")
    ap.add_argument("--sha256", action="store_true",
                    help="Print the SHA-256 of the trimmed body to stdout for each file that would be (or was) trimmed.")
    ap.add_argument("--verbose", action="store_true",
                    help="Print per-file outcome to stderr.")
    args = ap.parse_args(argv)

    # Single explicit file: strict about non-ZIP / missing
    single_file_mode = len(args.paths) == 1 and args.paths[0].is_file()
    if single_file_mode:
        try:
            with args.paths[0].open("rb"):
                pass
        except OSError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1

    counts: dict[str, int] = {}
    last_progress = time.monotonic()
    total_seen = 0
    real_errors = 0

    def emit_progress(force: bool = False) -> None:
        nonlocal last_progress
        now = time.monotonic()
        if not force and now - last_progress < 10:
            return
        last_progress = now
        summary = ", ".join(f"{k}={v}" for k, v in sorted(counts.items()))
        print(f"[{total_seen} processed] {summary}", file=sys.stderr)

    for fp in iter_inputs(args.paths, single_file_strict=False):
        outcome = process_file(fp, in_place=args.in_place, want_sha=args.sha256)
        counts[outcome.status] = counts.get(outcome.status, 0) + 1
        total_seen += 1
        if outcome.status == "error":
            real_errors += 1
            print(f"error {fp}: {outcome.detail}", file=sys.stderr)
        elif args.verbose:
            tail = f" {outcome.detail}" if outcome.detail else ""
            print(f"{outcome.status}{tail}: {fp}", file=sys.stderr)
        if outcome.status == "trimmed" and args.sha256 and outcome.new_sha256:
            print(f"{outcome.new_sha256}  {fp}")
        emit_progress()

    emit_progress(force=True)

    # Single-file strict mode: a single non-zip input is a usage error
    if single_file_mode and counts.get("skipped-non-zip", 0) == 1 and total_seen == 1:
        print(f"error: {args.paths[0]} does not look like a ZIP/.docx file", file=sys.stderr)
        return 1

    if not args.in_place:
        print("(dry-run; pass --in-place to rewrite)", file=sys.stderr)

    return 1 if real_errors else 0


if __name__ == "__main__":
    sys.exit(main())
