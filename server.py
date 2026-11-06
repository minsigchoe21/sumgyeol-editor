"""숨결 편집기 서버 (M1). 파이썬 표준 라이브러리만 씀 + ffmpeg/ffprobe.
실행: python server.py  → http://localhost:7800
- 원본은 제자리에 두고, data/media/<id>/ 에 편집용 저화질 사본(proxy.mp4)·썸네일·파형만 만들어요.
- 프로젝트는 projects/<이름>.shum (JSON)."""
import json, os, sys, shutil, subprocess, threading, hashlib, mimetypes, re, time, webbrowser
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
# 폴더 통일(11-06 "폴더 통일해", "구글드라이브에 올려도돼"):
#   Google Drive 01_쇼츠\숨결편집기\        ← 이 코드 + projects\ (두 PC가 같이 봄, Claude도 Drive로 읽음)
#   Google Drive 01_쇼츠\sources\<편>\     ← 원본 클립·내레이션·자막(두 PC 공용)
#   PC 로컬 %LOCALAPPDATA%\sumgyeol\      ← 편집용 저화질 사본(동기화 안 함)
SHORTS = os.path.dirname(ROOT)
if not (os.path.basename(SHORTS) == "01_쇼츠" or os.path.isdir(os.path.join(SHORTS, "지구의숨결"))): SHORTS = None
LOCAL = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".cache")
DATA = os.path.join(LOCAL, "sumgyeol"); MED = os.path.join(DATA, "media"); PROJ = os.path.join(ROOT, "projects"); STATIC = os.path.join(ROOT, "static")
SOURCES = os.path.join(SHORTS, "sources") if SHORTS else os.path.join(ROOT, "sources")
for d in (MED, PROJ, SOURCES): os.makedirs(d, exist_ok=True)
def rel_of(p):
    if SHORTS:
        try:
            r = os.path.relpath(p, SHORTS)
            if not r.startswith(".."): return r.replace("\\", "/")
        except ValueError: pass
    return None
def abs_of(p): return os.path.join(SHORTS, *p.split("/")) if SHORTS and not os.path.isabs(p) else p
PORT = int(os.environ.get("PORT", "7800"))

def tool(name):
    exe = name + (".exe" if os.name == "nt" else "")
    for local in (os.path.join(DATA, "bin", exe), os.path.join(ROOT, "bin", exe)):
        if os.path.exists(local): return local
    return shutil.which(name) or name
FFMPEG, FFPROBE = tool("ffmpeg"), tool("ffprobe")
NOWIN = 0x08000000 if os.name == "nt" else 0   # Windows에서 검은 창 안 뜨게

LOCK = threading.Lock()
DBF = os.path.join(DATA, "media.json")
DB = json.load(open(DBF, encoding="utf-8")) if os.path.exists(DBF) else {}
def save_db():
    with LOCK:
        tmp = DBF + ".tmp"; json.dump(DB, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1); os.replace(tmp, DBF)

VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
AUDIO_EXT = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}

def probe(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate",
                        "-of", "json", path], capture_output=True, text=True, creationflags=NOWIN)
    j = json.loads(r.stdout or "{}"); st = j.get("streams", [])
    v = next((s for s in st if s.get("codec_type") == "video"), None); a = any(s.get("codec_type") == "audio" for s in st)
    fps = 0.0
    if v and v.get("r_frame_rate", "0/0") != "0/0":
        n, d = v["r_frame_rate"].split("/"); fps = float(n) / float(d) if float(d) else 0.0
    return {"dur": float(j.get("format", {}).get("duration", 0) or 0), "w": v.get("width") if v else 0, "h": v.get("height") if v else 0,
            "fps": round(fps, 3), "has_audio": a}

def run(args): return subprocess.run([FFMPEG, "-y", "-v", "error"] + args, capture_output=True, text=True, creationflags=NOWIN)

def make_assets(mid):
    m = DB[mid]; src = m["path"]; d = os.path.join(MED, mid); os.makedirs(d, exist_ok=True)
    try:
        if m["kind"] == "video":
            # 편집용 사본: 짧은 변 540, 30fps, 키프레임 촘촘히(탐색 빠르게)
            sc = "scale=-2:540" if m["w"] >= m["h"] else "scale=540:-2"
            r = run(["-i", src, "-vf", sc + ",fps=30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "15", "-pix_fmt", "yuv420p",
                     "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", os.path.join(d, "proxy.mp4")])
            if r.returncode: raise RuntimeError(r.stderr[-400:])
            run(["-ss", str(min(1.0, m["dur"] / 3)), "-i", src, "-frames:v", "1", "-vf", "scale=320:-2", os.path.join(d, "thumb.jpg")])
            n = 10   # 썸네일 띠(타임라인 클립 배경)
            run(["-i", os.path.join(d, "proxy.mp4"), "-vf", f"fps={n}/{max(m['dur'], 0.1)},scale=-2:72,tile={n}x1", "-frames:v", "1", os.path.join(d, "strip.jpg")])
        elif m["kind"] == "audio":
            r = run(["-i", src, "-c:a", "aac", "-b:a", "160k", "-ac", "2", os.path.join(d, "proxy.m4a")])
            if r.returncode: raise RuntimeError(r.stderr[-400:])
        elif m["kind"] == "image":
            run(["-i", src, "-vf", "scale='min(1920,iw)':-2", os.path.join(d, "proxy.jpg")])
            run(["-i", src, "-vf", "scale=320:-2", os.path.join(d, "thumb.jpg")])
        if m.get("has_audio") or m["kind"] == "audio":   # 파형 그림
            run(["-i", src, "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1200x72:colors=#7fd0ff", "-frames:v", "1", os.path.join(d, "wave.png")])
        m["status"] = "ready"
    except Exception as e:
        m["status"] = "error"; m["error"] = str(e)
    save_db()

def import_paths(paths):
    out = []
    for p in paths:
        p = os.path.abspath(abs_of(p)); ext = os.path.splitext(p)[1].lower()
        if not os.path.isfile(p): continue
        kind = "video" if ext in VIDEO_EXT else "audio" if ext in AUDIO_EXT else "image" if ext in IMAGE_EXT else None
        if not kind: continue
        mid = hashlib.md5((p + str(os.path.getsize(p)) + str(os.path.getmtime(p))).encode()).hexdigest()[:12]
        if mid in DB and DB[mid].get("status") == "ready": out.append(mid); continue
        info = probe(p) if kind != "image" else {"dur": 5.0, "w": 0, "h": 0, "fps": 0, "has_audio": False}
        if kind == "image":
            pi = probe(p); info["w"], info["h"] = pi["w"], pi["h"]
        DB[mid] = {"id": mid, "name": os.path.basename(p), "path": p, "rel": rel_of(p), "kind": kind, "status": "working", "added": time.time(), **info}
        save_db(); threading.Thread(target=make_assets, args=(mid,), daemon=True).start(); out.append(mid)
    return out

def pick_files():
    """PC에서 파일 고르기 창(tkinter). 실패하면 빈 목록."""
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk(); root.withdraw(); root.attributes("-topmost", True)
        ps = filedialog.askopenfilenames(title="가져올 파일 고르기", initialdir=SOURCES, filetypes=[("미디어", "*.mp4 *.mov *.mkv *.webm *.m4v *.wav *.mp3 *.m4a *.flac *.png *.jpg *.jpeg *.webp"), ("모든 파일", "*.*")])
        root.destroy(); return list(ps)
    except Exception:
        return []

# ---------------------------------------------------------------- 채널·대본 추천·영상 가져오기 ----
import urllib.request, urllib.parse
KEYF = os.path.join(os.path.expanduser("~"), ".sumgyeol_keys.json")   # 키는 사용자가 직접 이 파일에 적어요(채팅에 붙이지 않음)
def keys():
    try: return json.load(open(KEYF, encoding="utf-8"))
    except Exception: return {}
CHF = os.path.join(ROOT, "channels.json")
def channels(): return json.load(open(CHF, encoding="utf-8"))
DL = os.path.join(SOURCES, "_받은영상"); os.makedirs(DL, exist_ok=True)
CREDF = os.path.join(DL, "credits.json")

def http_json(url, headers=None, data=None, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read().decode())

SCRIPT_FMT = """답은 JSON 하나만:
{"ideas":[{"title":"주제","hook":"첫 문장","why":"왜 볼까(한 줄)"}],
 "script":{"title":"고른 주제","sentences":[{"ko":"한국어 대사","en":"English subtitle","search":["pexels 검색어(영어) 1~3개"],"fact_source":"근거(기관·매체·연도)"}]}}
ideas는 3개, script는 그중 첫 번째로. 검색어는 무료 실사 영상(Pexels/Pixabay)에서 실제로 찾을 수 있는 구체적인 장면으로."""

def recommend(channel, topic, n_sent):
    k = keys()
    if not k.get("anthropic"): return {"error": f"Claude API 키가 없어요. {KEYF} 파일에 \"anthropic\" 키를 적어 주세요(사용법은 README)."}
    ch = next((c for c in channels() if c["id"] == channel), None)
    if not ch: return {"error": "채널을 못 찾았어요"}
    prompt = (f"채널: {ch['name']}\n채널 규칙:\n{ch['rules']}\n\n"
              f"주제: {topic or '(채널에 맞는 새 주제를 추천해 줘)'}\n문장 수: 약 {n_sent}문장\n\n{SCRIPT_FMT}")
    try:
        r = http_json("https://api.anthropic.com/v1/messages",
                      {"x-api-key": k["anthropic"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
                      {"model": k.get("model", "claude-sonnet-5-5"), "max_tokens": 4000, "messages": [{"role": "user", "content": prompt}]}, timeout=180)
        txt = "".join(b.get("text", "") for b in r.get("content", []))
        m = re.search(r"\{.*\}", txt, re.S)
        return json.loads(m.group(0)) if m else {"error": "답을 못 읽었어요", "raw": txt[:2000]}
    except urllib.error.HTTPError as e:
        return {"error": f"Claude API 오류 {e.code}: {e.read().decode()[:300]}"}
    except Exception as e:
        return {"error": f"Claude API 오류: {e}"}

def search(q, source, orient):
    k = keys(); out = []
    try:
        if source == "pexels":
            if not k.get("pexels"): return {"error": f"Pexels 키가 없어요. {KEYF}에 \"pexels\"를 적어 주세요."}
            u = "https://api.pexels.com/videos/search?" + urllib.parse.urlencode({"query": q, "per_page": 15, **({"orientation": orient} if orient else {})})
            for v in http_json(u, {"Authorization": k["pexels"]}).get("videos", []):
                fs = [f for f in v.get("video_files", []) if f.get("file_type") == "video/mp4" and f.get("width")]
                if not fs: continue
                best = min(fs, key=lambda f: abs(min(f["width"], f["height"]) - 1080))
                out.append({"source": "pexels", "id": str(v["id"]), "thumb": v.get("image"), "dur": v.get("duration"), "w": best["width"], "h": best["height"],
                            "dl": best["link"], "page": v.get("url"), "author": v.get("user", {}).get("name", ""), "license": "Pexels License"})
        elif source == "pixabay":
            if not k.get("pixabay"): return {"error": f"Pixabay 키가 없어요. {KEYF}에 \"pixabay\"를 적어 주세요."}
            u = "https://pixabay.com/api/videos/?" + urllib.parse.urlencode({"key": k["pixabay"], "q": q, "per_page": 15, "safesearch": "true"})
            for v in http_json(u).get("hits", []):
                vs = v.get("videos", {}); best = vs.get("large") if vs.get("large", {}).get("url") else vs.get("medium", {})
                out.append({"source": "pixabay", "id": str(v["id"]), "thumb": best.get("thumbnail") or vs.get("tiny", {}).get("thumbnail"), "dur": v.get("duration"),
                            "w": best.get("width"), "h": best.get("height"), "dl": best.get("url"), "page": v.get("pageURL"), "author": v.get("user", ""), "license": "Pixabay Content License"})
    except Exception as e:
        return {"error": f"검색 오류: {e}"}
    return {"items": out}

def fetch(item):
    """고른 영상을 받아 미디어로 가져오고, 출처를 credits.json에 적어요."""
    name = f"{item['source']}_{item['id']}.mp4"; dst = os.path.join(DL, name)
    if not os.path.exists(dst):
        req = urllib.request.Request(item["dl"], headers={"User-Agent": "Mozilla/5.0 (sumgyeol-editor)"})
        with urllib.request.urlopen(req, timeout=600) as r, open(dst + ".part", "wb") as f: shutil.copyfileobj(r, f, 1 << 20)
        os.replace(dst + ".part", dst)
    cr = json.load(open(CREDF, encoding="utf-8")) if os.path.exists(CREDF) else {}
    cr[name] = {k_: item.get(k_) for k_ in ("source", "id", "page", "author", "license")}
    json.dump(cr, open(CREDF, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    ids = import_paths([dst])
    for i in ids: DB[i]["credit"] = cr[name]
    save_db(); return ids

SAFE = re.compile(r"[^0-9A-Za-z가-힣_\-. ]")
def proj_path(name): return os.path.join(PROJ, SAFE.sub("_", name).strip() or "제목없음") + ".shum"

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json; charset=utf-8"); self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(b)
    def _body(self):
        n = int(self.headers.get("Content-Length", 0) or 0); return json.loads(self.rfile.read(n) or b"{}")
    def _file(self, path):
        if not os.path.isfile(path): return self.send_error(404)
        size = os.path.getsize(path); ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if path.endswith(".js"): ctype = "text/javascript; charset=utf-8"
        rng = self.headers.get("Range"); a, b = 0, size - 1
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1): a = int(m.group(1)); b = int(m.group(2)) if m.group(2) else size - 1
                else: a = size - int(m.group(2))
            b = min(b, size - 1); self.send_response(206); self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
        else: self.send_response(200)
        self.send_header("Content-Type", ctype); self.send_header("Accept-Ranges", "bytes"); self.send_header("Content-Length", str(b - a + 1))
        self.send_header("Cache-Control", "no-cache"); self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(a); left = b - a + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk: break
                    self.wfile.write(chunk); left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError): pass

    def do_GET(self):
        u = urlparse(self.path); p = unquote(u.path); q = parse_qs(u.query)
        if p == "/" or p == "/index.html": return self._file(os.path.join(STATIC, "index.html"))
        if p.startswith("/static/"): return self._file(os.path.join(STATIC, os.path.normpath(p[8:]).lstrip("\\/.")))
        if p == "/api/media": return self._json(sorted(DB.values(), key=lambda m: m.get("added", 0)))
        if p.startswith("/media/"):
            parts = p.split("/")
            if len(parts) == 4 and parts[2] in DB and parts[3] in ("proxy.mp4", "proxy.m4a", "proxy.jpg", "thumb.jpg", "strip.jpg", "wave.png"):
                return self._file(os.path.join(MED, parts[2], parts[3]))
            return self.send_error(404)
        if p == "/api/version": return self._json({"version": local_version() or "?"})
        if p == "/api/update/check":
            try: rv = remote_version()
            except Exception as e: return self._json({"local": local_version(), "error": str(e)})
            return self._json({"local": local_version(), "remote": rv, "update": bool(rv) and rv != local_version()})
        if p == "/api/channels": return self._json(channels())
        if p == "/api/keys": k = keys(); return self._json({n: bool(k.get(n)) for n in ("anthropic", "pexels", "pixabay")} | {"file": KEYF, "shorts": SHORTS, "sources": SOURCES, "projects": PROJ})
        if p == "/api/credits": return self._json(json.load(open(CREDF, encoding="utf-8")) if os.path.exists(CREDF) else {})
        if p == "/api/projects":
            fs = [f[:-5] for f in os.listdir(PROJ) if f.endswith(".shum")]
            fs.sort(key=lambda n: -os.path.getmtime(proj_path(n))); return self._json(fs)
        if p == "/api/project":
            f = proj_path(q.get("name", [""])[0])
            return self._json(json.load(open(f, encoding="utf-8"))) if os.path.exists(f) else self._json({"error": "없음"}, 404)
        self.send_error(404)

    def do_POST(self):
        p = urlparse(self.path).path
        if p == "/api/pick": return self._json({"ids": import_paths(pick_files())})
        if p == "/api/import": return self._json({"ids": import_paths(self._body().get("paths", []))})
        if p == "/api/resolve":   # 다른 PC에서 만든 프로젝트: 클립의 src(01_쇼츠 기준 상대 경로)로 다시 가져오기
            out = {}
            for src in self._body().get("srcs", []):
                ids = import_paths([src]); out[src] = ids[0] if ids else None
            return self._json(out)
        if p == "/api/project":
            j = self._body(); f = proj_path(j.get("name", "제목없음")); tmp = f + ".tmp"
            json.dump(j, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1); os.replace(tmp, f)
            return self._json({"ok": True, "path": f})
        if p == "/api/update/apply":
            try: apply_update()
            except Exception as e: return self._json({"error": f"업데이트 실패: {e}"}, 500)
            self._json({"ok": True, "version": local_version()}); threading.Thread(target=restart, daemon=True).start(); return
        if p == "/api/recommend":
            j = self._body(); return self._json(recommend(j.get("channel"), j.get("topic", ""), int(j.get("n", 14))))
        if p == "/api/search":
            j = self._body(); return self._json(search(j.get("q", ""), j.get("source", "pexels"), j.get("orient", "")))
        if p == "/api/fetch":
            try: return self._json({"ids": fetch(self._body())})
            except Exception as e: return self._json({"error": f"받기 오류: {e}"}, 500)
        if p == "/api/media/remove":
            mid = self._body().get("id")
            if mid in DB: DB.pop(mid); save_db(); shutil.rmtree(os.path.join(MED, mid), ignore_errors=True)
            return self._json({"ok": True})
        self.send_error(404)

# ---------------------------------------------------------------- 실행 중 자동 업데이트(11-06 "수정하고 껐다가 켜야 해?") ----
REPO = "minsigchoe21/sumgyeol-editor"
SERVER = None
def local_version():
    try: return open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip()
    except Exception: return ""
REMOTE_SHA = None
def remote_version():
    """GitHub API로 main의 최신 커밋을 알아내고, 그 커밋의 VERSION을 읽어요(raw 캐시 피하기)."""
    global REMOTE_SHA
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/commits/main", headers={"Accept": "application/vnd.github.sha", "User-Agent": "sumgyeol-editor"})
    with urllib.request.urlopen(req, timeout=8) as r: REMOTE_SHA = r.read().decode().strip()
    with urllib.request.urlopen(f"https://raw.githubusercontent.com/{REPO}/{REMOTE_SHA}/VERSION", timeout=8) as r: return r.read().decode().strip()
def apply_update():
    import zipfile, io
    sha = REMOTE_SHA or (remote_version() and REMOTE_SHA)
    with urllib.request.urlopen(f"https://codeload.github.com/{REPO}/zip/{sha}", timeout=60) as r: data = r.read()
    z = zipfile.ZipFile(io.BytesIO(data)); top = z.namelist()[0].split("/")[0]
    for n in z.namelist():
        if n.endswith("/"): continue
        rel = n[len(top) + 1:]
        if not rel or rel.startswith("projects/"): continue
        dst = os.path.join(ROOT, *rel.split("/"))
        if rel == "START.bat": dst = os.path.join(ROOT, "START.new.bat")   # 실행 중인 bat은 안 건드림
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst + ".tmp", "wb") as f: f.write(z.read(n))
        os.replace(dst + ".tmp", dst)
    sb, nb = os.path.join(ROOT, "START.bat"), os.path.join(ROOT, "START.new.bat")
    if os.path.exists(nb) and os.path.exists(sb) and open(sb, "rb").read() == open(nb, "rb").read(): os.remove(nb)
RESTART = False
def restart():   # 응답을 보낸 뒤 serve_forever를 멈추고, 메인 스레드가 새 버전으로 다시 켜요
    global RESTART
    time.sleep(0.5); RESTART = True; SERVER.shutdown()
def relaunch():
    print("[업데이트] 새 버전으로 다시 켜요…", local_version(), flush=True)
    SERVER.server_close()
    args = [a for a in sys.argv if a != "--no-browser"] + ["--no-browser"]
    if os.name == "nt":   # Windows: 같은 창에서 새 프로세스를 띄우고 기다림(창을 닫으면 같이 꺼짐)
        raise SystemExit(subprocess.call([sys.executable] + args, cwd=ROOT))
    os.execv(sys.executable, [sys.executable] + args)

def serve():
    global SERVER
    for i in range(40):   # 다시 켤 때 이전 프로세스가 포트를 놓을 때까지 기다림
        try: SERVER = ThreadingHTTPServer(("127.0.0.1", PORT), H); break
        except OSError: time.sleep(0.25)
    else: raise SystemExit("포트 %d을 쓸 수 없어요. 편집기가 이미 켜져 있는지 확인하세요." % PORT)
    return SERVER

if __name__ == "__main__":
    for m in DB.values():   # 끊겼던 작업 다시
        if m.get("status") == "working": threading.Thread(target=make_assets, args=(m["id"],), daemon=True).start()
    s = serve()
    url = f"http://localhost:{PORT}"; print("숨결 편집기:", url, local_version(), "(이 창을 닫으면 꺼져요)")
    if "--no-browser" not in sys.argv: threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try: s.serve_forever()
    except KeyboardInterrupt: pass
    if RESTART: relaunch()
