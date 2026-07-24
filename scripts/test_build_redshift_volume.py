from __future__ import annotations

import json
from pathlib import Path
import struct
import tempfile
import unittest

from astropy.constants import c
from astropy.cosmology import Planck18
from astropy.io import fits
import numpy as np

from scripts.build_redshift_volume import build_volume, comoving_distance_planck18


class RedshiftVolumeTest(unittest.TestCase):
    def test_planck18_distance_matches_independent_gauss_legendre_integral(self) -> None:
        redshift = 1.0
        nodes, weights = np.polynomial.legendre.leggauss(256)
        samples = 0.5 * redshift * (nodes + 1.0)
        integral = 0.5 * redshift * np.sum(weights / Planck18.efunc(samples))
        expected = integral * c.to_value("km/s") / Planck18.H0.to_value("km/(Mpc s)")
        actual = float(comoving_distance_planck18(np.array([redshift]))[0])
        self.assertAlmostEqual(actual, expected, delta=expected * 1e-8)

    def test_builds_filtered_binary_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            input_path = root / "fixture.fits"
            output_path = root / "volume"
            table = fits.BinTableHDU.from_columns([
                fits.Column(name="TARGETID", format="K", array=np.array([11, 12, 13, 14], dtype=np.int64)),
                fits.Column(name="TARGET_RA", format="D", array=np.array([150.0, 150.1, 150.2, 150.3])),
                fits.Column(name="TARGET_DEC", format="D", array=np.array([2.0, 2.1, 2.2, 2.3])),
                fits.Column(name="BEST_Z", format="D", array=np.array([0.5, 0.7, 0.8, -0.2])),
                fits.Column(name="ZERR", format="D", array=np.array([0.001, 0.002, 0.003, 0.004])),
                fits.Column(name="QUALITY_Z", format="L", array=np.array([True, False, True, True])),
                fits.Column(name="SPECTYPE", format="8A", array=np.array(["GALAXY", "GALAXY", "STAR", "GALAXY"])),
            ], name="SPECZ")
            fits.HDUList([fits.PrimaryHDU(), table]).writeto(input_path)

            manifest = build_volume(input_path, output_path, volume_id="fixture")
            self.assertEqual(manifest["pointCount"], 1)
            self.assertEqual(manifest["shellLevels"][3]["shellCount"], 8)
            loaded = json.loads((output_path / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(loaded["binary"]["format"], "astro-volume-v1")
            self.assertEqual(len(loaded["source"]["sha256"]), 64)
            self.assertEqual(len(loaded["binary"]["sha256"]), 64)
            self.assertTrue(loaded["provenance"]["scanRunId"].startswith("fixture-scan-"))
            scan_run = json.loads((output_path / "scan-run.json").read_text(encoding="utf-8"))
            self.assertEqual(scan_run["status"], "succeeded")
            self.assertEqual(len(scan_run["inputs"]), 1)
            self.assertEqual(len(scan_run["outputs"]), 2)
            self.assertEqual(len(scan_run["lineage"]), 2)

            binary = (output_path / "points.bin").read_bytes()
            magic, version, count, fields, header_bytes, _, _ = struct.unpack_from("<8sIIIIII", binary)
            self.assertEqual((magic, version, count, fields, header_bytes), (b"ASTRVOL1", 1, 1, 6, 32))
            self.assertAlmostEqual(struct.unpack_from("<f", binary, 32)[0], 150.0)
            target_offset = ((32 + count * 5 * 4 + 7) // 8) * 8
            self.assertEqual(struct.unpack_from("<Q", binary, target_offset)[0], 11)


if __name__ == "__main__":
    unittest.main()
