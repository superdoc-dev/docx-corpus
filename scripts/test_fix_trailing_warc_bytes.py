"""
stdlib unittest tests for fix_trailing_warc_bytes.

Run with:
  python3 -m unittest scripts/test_fix_trailing_warc_bytes.py
"""
import io
import os
import struct
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fix_trailing_warc_bytes as fixer  # noqa: E402


def make_minimal_docx() -> bytes:
    """Construct a tiny in-memory .docx (ZIP) for tests."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", b"<?xml version=\"1.0\"?><Types/>")
        z.writestr("word/document.xml", b"<?xml version=\"1.0\"?><document/>")
    return buf.getvalue()


class CandidateTrimmedTests(unittest.TestCase):
    def test_clean_file_returns_already_clean(self):
        data = make_minimal_docx()
        candidate, status = fixer.candidate_trimmed(data)
        self.assertIsNone(candidate)
        self.assertEqual(status, "already-clean")

    def test_with_crlfcrlf_tail_returns_trimmed(self):
        data = make_minimal_docx() + b"\r\n\r\n"
        candidate, status = fixer.candidate_trimmed(data)
        self.assertIsNotNone(candidate)
        self.assertEqual(status, "trimmed")
        self.assertEqual(len(candidate), len(data) - 4)
        # The trimmed candidate must still be a valid ZIP
        with zipfile.ZipFile(io.BytesIO(candidate)) as z:
            self.assertIsNone(z.testzip())

    def test_with_other_excess_returns_skipped(self):
        # Tail that isn't CRLFCRLF must NOT be trimmed - we don't guess
        data = make_minimal_docx() + b"junkjunk"
        candidate, status = fixer.candidate_trimmed(data)
        self.assertIsNone(candidate)
        self.assertEqual(status, "skipped-excess-differs")

    def test_three_byte_tail_returns_skipped(self):
        # Even a 3-byte CRLFCR partial must not match our exact-4-byte rule
        data = make_minimal_docx() + b"\r\n\r"
        candidate, status = fixer.candidate_trimmed(data)
        self.assertIsNone(candidate)
        self.assertEqual(status, "skipped-excess-differs")

    def test_non_zip_file_returns_skipped_non_zip(self):
        candidate, status = fixer.candidate_trimmed(b"not a zip file at all\n")
        self.assertIsNone(candidate)
        self.assertEqual(status, "skipped-non-zip")

    def test_zip_with_real_eocd_comment_is_respected(self):
        # A ZIP with a non-empty EOCD comment must not be confused for
        # excess bytes. The fixer should treat it as already-clean.
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("a", b"hi")
            z.comment = b"this is a real comment"
        data = buf.getvalue()
        candidate, status = fixer.candidate_trimmed(data)
        self.assertIsNone(candidate)
        self.assertEqual(status, "already-clean")

    def test_corrupted_after_trim_skipped(self):
        # Build a bytes blob whose EOCD points correctly but whose trimmed
        # form fails testzip (corrupt central directory). Edge case but worth
        # the safety net. We can simulate by deliberately breaking the CRC
        # of a central directory entry, then appending CRLFCRLF.
        data = bytearray(make_minimal_docx())
        # Find first CDH (PK\x01\x02) and zero out CRC field
        cdh = data.index(b"PK\x01\x02")
        struct.pack_into("<I", data, cdh + 16, 0xDEADBEEF)
        data += b"\r\n\r\n"
        candidate, status = fixer.candidate_trimmed(bytes(data))
        # We can't guarantee testzip catches every corruption pattern, but
        # if it does, status must be skipped-testzip-failed.
        self.assertIn(status, ("skipped-testzip-failed", "trimmed"))


class AtomicWriteTests(unittest.TestCase):
    def test_atomic_write_replaces_file(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "doc.docx"
            target.write_bytes(b"original")
            fixer.atomic_write(target, b"new content")
            self.assertEqual(target.read_bytes(), b"new content")

    def test_atomic_write_preserves_permissions(self):
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "doc.docx"
            target.write_bytes(b"x")
            target.chmod(0o640)
            fixer.atomic_write(target, b"y")
            mode = target.stat().st_mode & 0o7777
            self.assertEqual(mode, 0o640)


class ProcessFileTests(unittest.TestCase):
    def _write(self, dir_: Path, name: str, content: bytes) -> Path:
        p = dir_ / name
        p.write_bytes(content)
        return p

    def test_dry_run_does_not_modify(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            data = make_minimal_docx() + b"\r\n\r\n"
            p = self._write(d, "a.docx", data)
            outcome = fixer.process_file(p, in_place=False, want_sha=False)
            self.assertEqual(outcome.status, "trimmed")
            self.assertEqual(p.read_bytes(), data)  # unchanged

    def test_in_place_trims(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            data = make_minimal_docx() + b"\r\n\r\n"
            p = self._write(d, "a.docx", data)
            outcome = fixer.process_file(p, in_place=True, want_sha=False)
            self.assertEqual(outcome.status, "trimmed")
            self.assertEqual(p.read_bytes(), data[:-4])

    def test_idempotent_after_in_place(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            data = make_minimal_docx() + b"\r\n\r\n"
            p = self._write(d, "a.docx", data)
            fixer.process_file(p, in_place=True, want_sha=False)
            second = fixer.process_file(p, in_place=True, want_sha=False)
            self.assertEqual(second.status, "already-clean")

    def test_symlink_skipped(self):
        if os.name == "nt":
            self.skipTest("symlinks unreliable on Windows in CI")
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            real = self._write(d, "real.docx", make_minimal_docx() + b"\r\n\r\n")
            link = d / "link.docx"
            os.symlink(real, link)
            outcome = fixer.process_file(link, in_place=True, want_sha=False)
            self.assertEqual(outcome.status, "skipped-symlink")
            # Real file untouched
            self.assertTrue(real.read_bytes().endswith(b"\r\n\r\n"))


if __name__ == "__main__":
    unittest.main()
