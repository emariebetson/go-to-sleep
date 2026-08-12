import hashlib
import os
import sys
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))
try:
    from app.main import app, bearer_valid, inspect_image, normalize_phrase, phrase_hash, presentation_attack_check
    from PIL import Image
    from fastapi.testclient import TestClient
except ModuleNotFoundError:
    app = bearer_valid = inspect_image = normalize_phrase = phrase_hash = presentation_attack_check = Image = TestClient = None


@unittest.skipIf(normalize_phrase is None, "service dependencies are installed inside the processor container")
class ProcessorContractTest(unittest.TestCase):
    def test_phrase_normalization_is_deterministic(self):
        self.assertEqual(normalize_phrase("  MOON—river, 42! "), "moon river 42")
        self.assertEqual(phrase_hash("Moon River"), hashlib.sha256(b"moon river").hexdigest())

    def test_bearer_token_fails_closed(self):
        os.environ["NEARYOU_PROCESSOR_TOKEN"] = "x" * 32
        self.assertTrue(bearer_valid("Bearer " + "x" * 32))
        self.assertFalse(bearer_valid("Bearer " + "y" * 32))

    def test_probe_rejects_unauthorized_and_unbounded_media_before_provider_work(self):
        os.environ["NEARYOU_PROCESSOR_TOKEN"] = "x" * 32
        client = TestClient(app)
        headers = {
            "content-type": "audio/webm", "x-content-sha256": hashlib.sha256(b"x" * 1000).hexdigest(),
            "x-nearyou-household-id": "house", "x-nearyou-user-id": "user", "x-nearyou-contributor-id": "contributor",
        }
        self.assertEqual(client.post("/probe", content=b"x" * 1000, headers=headers).status_code, 401)
        headers["authorization"] = "Bearer " + "x" * 32
        with patch("app.main.MAX_BYTES", 999):
            self.assertEqual(client.post("/probe", content=b"x" * 1000, headers=headers).status_code, 413)

    def test_presentation_attack_detection_fails_closed_and_requires_high_confidence(self):
        class Response:
            def __init__(self, payload): self.payload = payload
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self): return __import__("json").dumps(self.payload).encode()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.webm"; path.write_bytes(b"verified audio")
            with patch.dict(os.environ, {"NEARYOU_ANTISPOOF_URL":"https://pad.example.test/check","NEARYOU_ANTISPOOF_TOKEN":"x"*32}), patch("urllib.request.urlopen", return_value=Response({"presentationAttackDetected":False,"liveProbability":0.95})):
                self.assertTrue(presentation_attack_check(path,"audio/webm","challenge"))
            with patch.dict(os.environ, {"NEARYOU_ANTISPOOF_URL":"https://pad.example.test/check","NEARYOU_ANTISPOOF_TOKEN":"x"*32}), patch("urllib.request.urlopen", return_value=Response({"presentationAttackDetected":True,"liveProbability":0.99})):
                self.assertFalse(presentation_attack_check(path,"audio/webm","challenge"))

    def test_image_probe_fully_decodes_and_rejects_truncation_polyglots_and_pixel_bombs(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"valid.png"; image=Image.new("RGB",(12,10),(20,30,40)); image.save(path,"PNG")
            self.assertEqual(inspect_image(path,"image/png"),(12,10,"PNG"))
            truncated=Path(directory)/"truncated.png"; truncated.write_bytes(path.read_bytes()[:-8])
            with self.assertRaises(ValueError): inspect_image(truncated,"image/png")
            polyglot=Path(directory)/"polyglot.png"; polyglot.write_bytes(path.read_bytes()+b"<script>alert(1)</script>")
            with self.assertRaises(ValueError): inspect_image(polyglot,"image/png")
            with patch("app.main.MAX_IMAGE_PIXELS",50):
                with self.assertRaises(ValueError): inspect_image(path,"image/png")
            with patch.dict(os.environ, {}, clear=True):
                self.assertFalse(presentation_attack_check(path,"audio/webm","challenge"))


if __name__ == "__main__":
    unittest.main()
