#!/usr/bin/env python3
"""
Piper TTS sidecar.

Girdi  (stdin) : her satirda bir JSON istek
      {"id": 7, "text": "merhaba", "length_scale": 1.1}
Cikti  (stdout): once JSON baslik satirlari, sonra ham PCM (16-bit LE, mono)
      {"t":"ready","sample_rate":22050,...}
      {"t":"start","id":7}
      {"t":"chunk","id":7,"n":44100}   + 44100 bayt PCM
      {"t":"end","id":7,"bytes":44100}
      {"t":"error","id":7,"message":"..."}

Onemli: stdout YALNIZCA bu protokol icindir; tum loglar stderr'e yazilir.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import traceback


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--config")
    parser.add_argument("--cuda", action="store_true")
    args = parser.parse_args()

    from piper import PiperVoice, SynthesisConfig

    out = sys.stdout.buffer

    def emit(payload: dict) -> None:
        out.write(json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n")
        out.flush()

    started = time.perf_counter()
    voice = PiperVoice.load(args.model, config_path=args.config, use_cuda=args.cuda)
    log(f"[sidecar] model yuklendi ({time.perf_counter() - started:.2f}s)")

    cfg = voice.config
    emit(
        {
            "t": "ready",
            "sample_rate": int(cfg.sample_rate),
            "channels": 1,
            "sample_width": 2,
            "phoneme_type": str(getattr(cfg, "phoneme_type", "")),
            "espeak_voice": str(getattr(cfg, "espeak_voice", "")),
            "num_speakers": int(getattr(cfg, "num_speakers", 1) or 1),
            "speakers": {str(k): str(v) for k, v in (getattr(cfg, "speaker_id_map", {}) or {}).items()},
        }
    )

    # Windows'ta stdin varsayilan olarak cp1252'dir; Turkce harfleri bozmasin diye
    # ham baytlardan UTF-8 ile cozuyoruz.
    stdin_bytes = sys.stdin.buffer
    for raw_bytes in stdin_bytes:
        raw = raw_bytes.decode("utf-8", errors="replace").strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as err:
            emit({"t": "error", "id": None, "message": f"gecersiz JSON: {err}"})
            continue

        req_id = req.get("id")
        text = (req.get("text") or "").strip()
        if not text:
            emit({"t": "error", "id": req_id, "message": "bos metin"})
            continue

        try:
            syn = SynthesisConfig(
                speaker_id=int(req.get("speaker_id", 0)),
                length_scale=float(req.get("length_scale", 1.0)),
                noise_scale=float(req.get("noise_scale", 0.667)),
                noise_w_scale=float(req.get("noise_w_scale", 0.8)),
                normalize_audio=bool(req.get("normalize_audio", True)),
                volume=1.0,
            )
            t0 = time.perf_counter()
            emit({"t": "start", "id": req_id, "ts": time.time()})
            total = 0
            first_ms = None
            for chunk in voice.synthesize(text, syn):
                data = chunk.audio_int16_bytes
                if not data:
                    continue
                if first_ms is None:
                    first_ms = (time.perf_counter() - t0) * 1000
                emit({"t": "chunk", "id": req_id, "n": len(data)})
                out.write(data)
                out.flush()
                total += len(data)
            elapsed = (time.perf_counter() - t0) * 1000
            emit(
                {
                    "t": "end",
                    "id": req_id,
                    "bytes": total,
                    "first_ms": round(first_ms or 0.0, 1),
                    "total_ms": round(elapsed, 1),
                }
            )
        except Exception as err:  # noqa: BLE001
            log("[sidecar] hata:", traceback.format_exc())
            emit({"t": "error", "id": req_id, "message": str(err)})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        pass
    except Exception:  # noqa: BLE001
        log("[sidecar] kritik hata:", traceback.format_exc())
        sys.exit(1)
