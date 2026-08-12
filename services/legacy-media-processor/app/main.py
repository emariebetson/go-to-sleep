from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import subprocess
import tempfile
import unicodedata
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request
from PIL import Image, UnidentifiedImageError

MAX_BYTES = 50_000_000
ALLOWED_TYPES = {"audio/webm": ".webm", "audio/mp4": ".m4a", "audio/mpeg": ".mp3"}
app = FastAPI(title="NearLegacy Media Processor", docs_url=None, redoc_url=None)
MAX_IMAGE_PIXELS = 40_000_000


def normalize_phrase(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(re.findall(r"[a-z0-9]+", normalized))


def phrase_hash(value: str) -> str:
    return hashlib.sha256(normalize_phrase(value).encode()).hexdigest()


def bearer_valid(value: Optional[str]) -> bool:
    expected = os.environ.get("NEARYOU_PROCESSOR_TOKEN", "")
    supplied = value.removeprefix("Bearer ") if value else ""
    return len(expected) >= 32 and hmac.compare_digest(expected, supplied)


def probe_audio(path: Path) -> tuple[int, str]:
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration,format_name", "-of", "json", str(path)],
        capture_output=True, text=True, timeout=15, check=True,
    )
    payload = json.loads(result.stdout)
    duration_ms = round(float(payload["format"]["duration"]) * 1000)
    if duration_ms < 1_000 or duration_ms > 7_200_000:
        raise ValueError("duration_out_of_bounds")
    return duration_ms, str(payload["format"].get("format_name", ""))


def normalized_fingerprint(path: Path) -> str:
    result = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
        capture_output=True, timeout=30, check=True,
    )
    pcm = result.stdout
    if len(pcm) < 16_000:
        raise ValueError("audio_too_short")
    samples = [int.from_bytes(pcm[index:index + 2], "little", signed=True) for index in range(0, len(pcm) - 1, 2)]
    rms = (sum(sample * sample for sample in samples) / len(samples)) ** 0.5
    if rms < 120:
        raise ValueError("audio_is_silent")
    return hashlib.sha256(pcm).hexdigest()


def transcribe(path: Path, content_type: str) -> str:
    api_key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not api_key:
        raise RuntimeError("transcription_unavailable")
    boundary = f"----nearyou-{uuid.uuid4().hex}"
    file_bytes = path.read_bytes()
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"model_id\"\r\n\r\nscribe_v1\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"evidence\"\r\nContent-Type: {content_type}\r\n\r\n"
    ).encode() + file_bytes + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request(
        "https://api.elevenlabs.io/v1/speech-to-text", data=body, method="POST",
        headers={"xi-api-key": api_key, "content-type": f"multipart/form-data; boundary={boundary}", "idempotency-key": hashlib.sha256(file_bytes).hexdigest()},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return str(json.loads(response.read())["text"])


def presentation_attack_check(path: Path, content_type: str, challenge_id: str) -> bool:
    """Use an independently deployed PAD model; phrase matching alone is not liveness."""
    endpoint = os.environ.get("NEARYOU_ANTISPOOF_URL", "")
    token = os.environ.get("NEARYOU_ANTISPOOF_TOKEN", "")
    if not endpoint.startswith("https://") or len(token) < 32:
        return False
    request = urllib.request.Request(
        endpoint, data=path.read_bytes(), method="POST",
        headers={"authorization": f"Bearer {token}", "content-type": content_type,
                 "x-nearyou-challenge-id": challenge_id},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.loads(response.read())
    return payload.get("presentationAttackDetected") is False and float(payload.get("liveProbability", 0)) >= 0.90


async def bounded_body(request: Request) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BYTES:
            raise HTTPException(413, "media_too_large")
        chunks.append(chunk)
    if size < 1_000:
        raise HTTPException(422, "media_too_small")
    return b"".join(chunks)


def inspect_image(path: Path, expected_type: str) -> tuple[int, int, str]:
    expected = {"image/jpeg": "JPEG", "image/png": "PNG"}.get(expected_type)
    if not expected:
        raise ValueError("invalid_image_type")
    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            width, height, format_name = image.width, image.height, image.format
            image.load()
    except (UnidentifiedImageError, OSError, SyntaxError):
        raise ValueError("invalid_image") from None
    if format_name != expected or width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
        raise ValueError("invalid_image_dimensions")
    raw = path.read_bytes()
    if expected == "JPEG" and not raw.endswith(b"\xff\xd9"):
        raise ValueError("trailing_or_truncated_image")
    if expected == "PNG" and not raw.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82"):
        raise ValueError("trailing_or_truncated_image")
    return width, height, format_name


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/readyz")
def ready() -> dict[str, str]:
    if not bearer_valid(f"Bearer {os.environ.get('NEARYOU_PROCESSOR_TOKEN', '')}") or not os.environ.get("ELEVENLABS_API_KEY") or not os.environ.get("NEARYOU_ANTISPOOF_URL", "").startswith("https://") or len(os.environ.get("NEARYOU_ANTISPOOF_TOKEN", "")) < 32:
        raise HTTPException(503, "processor_not_configured")
    for binary in ("ffmpeg", "ffprobe"):
        subprocess.run([binary, "-version"], capture_output=True, timeout=3, check=True)
    return {"status": "ready"}


@app.post("/probe")
async def probe(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    content_type: Optional[str] = Header(default=None),
    x_content_sha256: Optional[str] = Header(default=None),
    x_nearyou_household_id: Optional[str] = Header(default=None),
    x_nearyou_user_id: Optional[str] = Header(default=None),
    x_nearyou_contributor_id: Optional[str] = Header(default=None),
    x_nearyou_challenge_id: Optional[str] = Header(default=None),
    x_nearyou_challenge_phrase: Optional[str] = Header(default=None),
) -> dict[str, object]:
    if not bearer_valid(authorization):
        raise HTTPException(401, "unauthorized")
    if content_type not in ALLOWED_TYPES or not re.fullmatch(r"[A-Za-z0-9:_-]{1,200}", x_nearyou_household_id or ""):
        raise HTTPException(422, "invalid_media_scope")
    if not all(re.fullmatch(r"[A-Za-z0-9:_-]{1,200}", value or "") for value in (x_nearyou_user_id, x_nearyou_contributor_id)):
        raise HTTPException(422, "invalid_identity_scope")
    body = await bounded_body(request)
    checksum = hashlib.sha256(body).hexdigest()
    if not x_content_sha256 or not hmac.compare_digest(checksum, x_content_sha256.lower()):
        raise HTTPException(422, "checksum_mismatch")
    with tempfile.TemporaryDirectory(prefix="nearyou-media-") as directory:
        path = Path(directory) / f"input{ALLOWED_TYPES[content_type]}"
        path.write_bytes(body)
        try:
            duration_ms, _ = probe_audio(path)
            fingerprint = normalized_fingerprint(path)
        except (KeyError, ValueError, subprocess.SubprocessError, json.JSONDecodeError):
            raise HTTPException(422, "invalid_audio") from None
        response: dict[str, object] = {
            "checksum": checksum, "byteSize": len(body), "contentType": content_type,
            "durationMs": duration_ms, "audioFingerprint": fingerprint,
            "processorReceiptId": str(uuid.uuid4()),
        }
        if x_nearyou_challenge_id or x_nearyou_challenge_phrase:
            if not x_nearyou_challenge_id or not x_nearyou_challenge_phrase or not 12 <= len(x_nearyou_challenge_phrase.split()) <= 24:
                raise HTTPException(422, "invalid_challenge")
            try:
                transcript = transcribe(path, content_type)
            except Exception:
                raise HTTPException(503, "transcription_unavailable") from None
            matched = normalize_phrase(transcript) == normalize_phrase(x_nearyou_challenge_phrase)
            try:
                live_verified = matched and presentation_attack_check(path, content_type, x_nearyou_challenge_id)
            except Exception:
                raise HTTPException(503, "liveness_verification_unavailable") from None
            response.update({
                "challengeId": x_nearyou_challenge_id,
                "phraseHash": phrase_hash(x_nearyou_challenge_phrase),
                "phraseMatched": matched,
                "liveSpeakerVerified": live_verified,
            })
        return response


@app.post("/image-probe")
async def image_probe(request: Request, authorization: Optional[str] = Header(default=None),
                      content_type: Optional[str] = Header(default=None),
                      x_content_sha256: Optional[str] = Header(default=None),
                      x_nearyou_household_id: Optional[str] = Header(default=None),
                      x_nearyou_user_id: Optional[str] = Header(default=None)) -> dict[str, object]:
    if not bearer_valid(authorization): raise HTTPException(401, "unauthorized")
    if content_type not in ("image/jpeg", "image/png") or not all(re.fullmatch(r"[A-Za-z0-9:_-]{1,200}", value or "") for value in (x_nearyou_household_id, x_nearyou_user_id)):
        raise HTTPException(422, "invalid_image_scope")
    body = await bounded_body(request); checksum = hashlib.sha256(body).hexdigest()
    if not x_content_sha256 or not hmac.compare_digest(checksum, x_content_sha256.lower()): raise HTTPException(422, "checksum_mismatch")
    with tempfile.TemporaryDirectory(prefix="nearyou-image-") as directory:
        path = Path(directory) / ("photo.png" if content_type == "image/png" else "photo.jpg"); path.write_bytes(body)
        try: width, height, format_name = inspect_image(path, content_type)
        except ValueError: raise HTTPException(422, "invalid_image") from None
    return {"checksum": checksum, "byteSize": len(body), "contentType": content_type,
            "width": width, "height": height, "format": format_name,
            "processorReceiptId": str(uuid.uuid4())}
