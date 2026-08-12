"""NearYou media worker deployment contract. No network listener starts by default."""
from __future__ import annotations
import json
import os
import subprocess
import re
from pathlib import Path
from dataclasses import dataclass

@dataclass(frozen=True)
class Job:
    id: str
    household_id: str
    operation: str
    input_path: str
    output_path: str

ALLOWED_OPERATIONS = {"normalize"}

def process(job: Job) -> dict[str, str]:
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", job.id) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", job.household_id):
        raise ValueError("invalid job identity")
    if job.operation not in ALLOWED_OPERATIONS:
        raise ValueError("unsupported media operation")
    input_root, output_root = Path(os.environ.get("NEARYOU_INPUT_ROOT", "/work/input")).resolve(), Path(os.environ.get("NEARYOU_OUTPUT_ROOT", "/work/output")).resolve()
    lexical_source, lexical_target = Path(job.input_path), Path(job.output_path)
    lexical_input_root = Path(os.environ.get("NEARYOU_INPUT_ROOT", "/work/input"))
    lexical_output_root = Path(os.environ.get("NEARYOU_OUTPUT_ROOT", "/work/output"))
    def has_symlink_component(path: Path, root: Path, allow_missing_leaf: bool = False) -> bool:
        try: relative = path.relative_to(root)
        except ValueError: return True
        current = root
        for index, part in enumerate(relative.parts):
            current = current / part
            if allow_missing_leaf and index == len(relative.parts) - 1 and not current.exists(): return False
            if current.is_symlink(): return True
        return False
    if has_symlink_component(lexical_source, lexical_input_root) or has_symlink_component(lexical_target, lexical_output_root, True):
        raise ValueError("symbolic media paths are prohibited")
    source, target = lexical_source.resolve(), lexical_target.resolve()
    if not source.is_relative_to(input_root) or not target.is_relative_to(output_root):
        raise ValueError("media paths must remain inside isolated work directories")
    if not source.is_file() or source.stat().st_nlink != 1 or target.exists():
        raise ValueError("media input/output lifecycle is invalid")
    if job.operation == "normalize":
        try:
            subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
                            "-i", str(source), "-t", "7200", "-af", "loudnorm", "-map_metadata", "-1", str(target)],
                           check=True, timeout=300)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
    else:
        raise RuntimeError("operation handler is not enabled in this worker image")
    return {"jobId": job.id, "status": "completed"}

def main() -> None:
    if os.environ.get("NEARYOU_MEDIA_WORKER_ENABLED") != "true":
        raise SystemExit("media worker is disabled")
    raw = json.loads(input())
    print(json.dumps(process(Job(**raw))))

if __name__ == "__main__":
    main()
