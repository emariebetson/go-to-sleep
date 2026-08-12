import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from worker import Job, process

class WorkerSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.input_root, self.output_root = root / "input", root / "output"
        self.input_root.mkdir(); self.output_root.mkdir()
        self.source = self.input_root / "audio.wav"; self.source.write_bytes(b"RIFFfixture")
        os.environ["NEARYOU_INPUT_ROOT"] = str(self.input_root)
        os.environ["NEARYOU_OUTPUT_ROOT"] = str(self.output_root)

    def tearDown(self):
        self.temp.cleanup()

    def job(self, source=None, target=None):
        return Job("job_12345678", "household_12345678", "normalize", str(source or self.source), str(target or self.output_root / "normalized.mp3"))

    def test_rejects_path_traversal_and_symlink_input(self):
        outside = Path(self.temp.name) / "outside.wav"; outside.write_bytes(b"RIFF")
        with self.assertRaises(ValueError): process(self.job(outside))
        link = self.input_root / "link.wav"; link.symlink_to(outside)
        with self.assertRaises(ValueError): process(self.job(link))
        nested = self.input_root / "nested"; nested.mkdir()
        in_root_link = self.input_root / "alias"; in_root_link.symlink_to(nested, target_is_directory=True)
        nested_source = nested / "audio.wav"; nested_source.write_bytes(b"RIFF")
        with self.assertRaises(ValueError): process(self.job(in_root_link / "audio.wav"))

    def test_timeout_cleans_partial_output(self):
        target = self.output_root / "partial.mp3"
        def fail(*args, **kwargs):
            target.write_bytes(b"partial")
            raise TimeoutError("bounded timeout")
        with patch("worker.subprocess.run", fail), self.assertRaises(TimeoutError): process(self.job(target=target))
        self.assertFalse(target.exists())

    def test_normalize_uses_restricted_ffmpeg_protocols(self):
        with patch("worker.subprocess.run") as run:
            result = process(self.job())
        self.assertEqual(result["status"], "completed")
        command = run.call_args.args[0]
        self.assertIn("-protocol_whitelist", command)
        self.assertEqual(run.call_args.kwargs["timeout"], 300)

if __name__ == "__main__": unittest.main()
