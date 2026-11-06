"""숨결 편집기 목소리(11-07 "음성도 자막 넣을 때 같이"): Supertonic TTS(sherpa-onnx)를 이 PC에서 돌려요.
처음 한 번: pip로 sherpa-onnx 설치 + 모델(약 85MB, GitHub k2-fsa/sherpa-onnx)을 %LOCALAPPDATA%\\sumgyeol\\tts 에 받아요."""
import os, sys, subprocess, tarfile, urllib.request, wave, array, threading
MODEL = "sherpa-onnx-supertonic-tts-int8-2026-03-06"
URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/{MODEL}.tar.bz2"
STATE = {"state": "", "ready": False}
_tts = None; _lock = threading.Lock()

def ensure(data_dir):
    global _tts
    if _tts: return _tts
    with _lock:
        if _tts: return _tts
        lib = os.path.join(data_dir, "pylib")   # 편집기 전용 폴더에 설치(사용자 site 경로 문제 피하기, 11-07 "No module named sherpa_onnx")
        if lib not in sys.path: sys.path.insert(0, lib)
        try: import sherpa_onnx
        except ImportError:
            STATE["state"] = "목소리 프로그램 설치 중(처음 한 번, 1~3분)…"
            r = subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", "--target", lib, "sherpa-onnx"], capture_output=True, text=True,
                               creationflags=0x08000000 if os.name == "nt" else 0)
            if r.returncode: raise RuntimeError("sherpa-onnx 설치 실패: " + (r.stderr or r.stdout)[-400:])
            import importlib; importlib.invalidate_caches()
            import sherpa_onnx
        d = os.path.join(data_dir, "tts"); m = os.path.join(d, MODEL); os.makedirs(d, exist_ok=True)
        if not os.path.exists(os.path.join(m, "voice.bin")):
            STATE["state"] = "목소리 모델 받는 중(처음 한 번, 약 85MB)…"
            tmp = os.path.join(d, "m.tar.bz2")
            urllib.request.urlretrieve(URL, tmp)
            with tarfile.open(tmp, "r:bz2") as t: t.extractall(d)
            os.remove(tmp)
        STATE["state"] = "목소리 준비 중…"
        cfg = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(supertonic=sherpa_onnx.OfflineTtsSupertonicModelConfig(
            duration_predictor=f"{m}/duration_predictor.int8.onnx", text_encoder=f"{m}/text_encoder.int8.onnx", vector_estimator=f"{m}/vector_estimator.int8.onnx",
            vocoder=f"{m}/vocoder.int8.onnx", tts_json=f"{m}/tts.json", unicode_indexer=f"{m}/unicode_indexer.bin", voice_style=f"{m}/voice.bin"),
            num_threads=max(2, (os.cpu_count() or 4) // 2)))
        _tts = sherpa_onnx.OfflineTts(cfg); STATE.update(state="목소리 준비 끝", ready=True)
        return _tts

def synth(data_dir, text, out_wav, sid=7, speed=1.15, steps=10):
    """원시 음성을 wav(16비트)로. 길이(초)를 돌려줘요."""
    tts = ensure(data_dir)
    import sherpa_onnx
    g = sherpa_onnx.GenerationConfig(); g.sid = sid; g.speed = speed; g.num_steps = steps; g.extra = {"lang": "ko"}
    a = tts.generate(text, g); sm = a.samples
    pcm = array.array("h", (max(-32767, min(32767, int(x * 32767))) for x in sm))
    with wave.open(out_wav, "wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(a.sample_rate); w.writeframes(pcm.tobytes())
    return len(sm) / a.sample_rate

def f0_median(wav_path):
    """목소리 높낮이(기본 주파수) 중앙값(Hz). 문장마다 높낮이가 들쭉날쭉하지 않게 고를 때 써요(11-07)."""
    try: import numpy as np
    except ImportError: return None
    with wave.open(wav_path, "rb") as w:
        sr = w.getframerate(); x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    n = int(0.04 * sr); hop = n // 2; out = []; rms_all = float(np.sqrt(np.mean(x ** 2)) + 1e-9)
    lo, hi = int(sr / 400), int(sr / 70)
    for i in range(0, len(x) - n, hop):
        f = x[i:i + n] - x[i:i + n].mean()
        if np.sqrt(np.mean(f ** 2)) < rms_all * 0.6: continue
        ac = np.correlate(f, f, "full")[n - 1:]
        k = lo + int(np.argmax(ac[lo:hi]))
        if ac[k] > 0.3 * ac[0]: out.append(sr / k)
    return float(np.median(out)) if out else None
