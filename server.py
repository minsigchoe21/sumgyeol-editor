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
def find_shorts():   # 압축을 풀며 폴더가 한 겹 더 생겨도(…\01_쇼츠\sumgyeol_editor_auto\sumgyeol_editor) 위로 올라가며 01_쇼츠를 찾아요
    d = ROOT
    for _ in range(5):
        d = os.path.dirname(d)
        if os.path.basename(d) == "01_쇼츠" or os.path.isdir(os.path.join(d, "지구의숨결")): return d
        if os.path.dirname(d) == d: break
    return None
SHORTS = find_shorts()
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
            r = run(["-i", src, "-vf", sc + ",fps=30", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "fastdecode", "-crf", "27", "-g", "15", "-pix_fmt", "yuv420p",
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

# 사본 만들기는 한 번에 2개만(11-07 4K 영상 13개를 한꺼번에 돌려 PC가 멈추던 문제)
import queue as _queue
AQ = _queue.Queue(); AQ_N = {"waiting": 0}
def _aworker():
    while True:
        mid = AQ.get(); AQ_N["waiting"] = max(0, AQ_N["waiting"] - 1)
        try: make_assets(mid)
        except Exception as e: log(f"assets error {mid}: {e}")
def queue_assets(mid):
    AQ_N["waiting"] += 1; AQ.put(mid)
for _ in range(2): threading.Thread(target=_aworker, daemon=True).start()

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
        save_db(); queue_assets(mid); out.append(mid)
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
# 키 파일(11-07 "두 PC에서 같이"): 구글 드라이브 01_쇼츠\_private\sumgyeol_keys.json 을 두 PC가 같이 읽어요.
# 01_쇼츠를 못 찾으면 이 PC의 ~\.sumgyeol_keys.json. 예전 PC 파일에 키가 있으면 드라이브 파일로 한 번 옮겨요.
KEYF_LOCAL = os.path.join(os.path.expanduser("~"), ".sumgyeol_keys.json")
KEYF = os.path.join(SHORTS, "_private", "sumgyeol_keys.json") if SHORTS else KEYF_LOCAL
if KEYF != KEYF_LOCAL:
    try:
        os.makedirs(os.path.dirname(KEYF), exist_ok=True)
        if os.path.exists(KEYF_LOCAL):
            old = json.load(open(KEYF_LOCAL, encoding="utf-8")); cur = json.load(open(KEYF, encoding="utf-8")) if os.path.exists(KEYF) else {}
            merged = {**old, **{k_: v_ for k_, v_ in cur.items() if v_}}
            if merged != cur: json.dump(merged, open(KEYF, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    except Exception: pass
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

# 답을 늘 올바른 JSON으로 받으려고 "도구 사용(tool use)"으로 형식을 강제해요(11-06 "Expecting ',' delimiter" 오류 대응)
S_STR = {"type": "string"}
SCHEMAS = {
  "keywords": {"type": "object", "properties": {"keywords": {"type": "array", "items": S_STR}}, "required": ["keywords"]},
  "recommend": {"type": "object", "properties": {
      "ideas": {"type": "array", "items": {"type": "object", "properties": {"title": S_STR, "hook": S_STR, "why": S_STR}, "required": ["title"]}},
      "script": {"type": "object", "properties": {"title": S_STR, "sentences": {"type": "array", "items": {"type": "object", "properties": {
          "ko": S_STR, "en": S_STR, "search": {"type": "array", "items": S_STR}, "fact_source": S_STR}, "required": ["ko", "en"]}}}, "required": ["title", "sentences"]}},
      "required": ["ideas", "script"]},
  "media_script": {"type": "object", "properties": {"title": S_STR, "hook": S_STR,
      "clips_note": {"type": "array", "items": {"type": "object", "properties": {"clip": S_STR, "what": S_STR, "species_ok": {"type": "boolean"}}, "required": ["clip", "what"]}},
      "sentences": {"type": "array", "items": {"type": "object", "properties": {"ko": S_STR, "en": S_STR, "clip": S_STR, "clip_in": {"type": "number"}, "fact_source": S_STR}, "required": ["ko", "en", "clip"]}}},
      "required": ["title", "sentences"]},
}
SCHEMAS["describe"] = {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
    "i": {"type": "integer"}, "ko": S_STR, "topic": S_STR}, "required": ["i", "ko"]}}}, "required": ["items"]}
WONDER_KO = {"bioluminescence": "빛나는 바다(생물발광)", "murmuration starlings": "찌르레기 떼의 군무", "mimic octopus": "흉내문어", "cuttlefish color change": "갑오징어 색 바꾸기",
    "volcano lava flow": "흐르는 용암", "aurora timelapse": "오로라 타임랩스", "jellyfish swarm": "해파리 떼", "coral spawning": "산호 산란", "humpback whale breach": "혹등고래 점프",
    "slime mold timelapse": "점균 타임랩스", "lightning storm slow motion": "번개 슬로모션", "glacier calving": "빙하 붕괴", "sardine run": "정어리 떼 이동", "manta ray": "만타가오리",
    "hummingbird slow motion": "벌새 슬로모션", "mantis shrimp": "갯가재", "firefly synchronous": "반딧불이 동시 점멸", "sea otter": "해달", "chameleon tongue": "카멜레온 혀",
    "leafcutter ants": "가위개미", "geyser eruption": "간헐천 분출", "sand dunes wind": "바람에 움직이는 사구", "space station earth view": "우주정거장에서 본 지구", "solar flare": "태양 플레어",
    "comet": "혜성", "deep sea creature": "심해 생물", "seahorse": "해마", "fungi growth timelapse": "버섯 자라는 타임랩스", "dragonfly emerging": "잠자리 날개돋이", "salmon run": "연어 회귀"}
def describe(items):
    """검색 결과 카드에 붙일 한 줄 한국어 설명(11-06 "어떤 내용인지 간략하게 한글로")."""
    if not keys().get("anthropic"):
        return {"items": [{"i": i, "ko": WONDER_KO.get(it.get("kw", ""), it.get("title") or it.get("kw") or ""), "topic": WONDER_KO.get(it.get("kw", ""), "")} for i, it in enumerate(items)]}
    lines = [f"{i}. [{it.get('source')}] 검색어: {it.get('kw') or ''} / 제목·태그: {it.get('title') or ''} / 설명: {it.get('desc') or ''}" for i, it in enumerate(items)]
    return claude("아래는 무료 영상 검색 결과예요. 각 영상이 무엇을 보여 주는지 한국어 한 줄(20자 안팎)로 쉽게 써 주고, "
                  "쇼츠 주제로 쓸 짧은 한국어 이름(topic, 예: 해달·빛나는 바다)도 붙여 줘. 모르는 건 추측하지 말고 제목에 있는 것만.\n" + "\n".join(lines), 2500, "describe")

def _call(body):
    k = keys()
    return http_json("https://api.anthropic.com/v1/messages",
                     {"x-api-key": k["anthropic"], "anthropic-version": "2023-06-01", "content-type": "application/json"}, body, timeout=300)
def _parse_text(txt):
    t = re.sub(r"^```(json)?|```$", "", txt.strip(), flags=re.M).strip()
    m = re.search(r"\{.*\}", t, re.S)
    return json.loads(m.group(0)) if m else None
FORCE_OK = True   # 도구 강제가 안 되는 모델이면 한 번 실패한 뒤로는 바로 auto
def claude(content, max_tokens=6000, schema="recommend"):
    """Claude에게 묻고 JSON(dict)으로 받아요. answer 도구로 형식을 맞추되, 모델이 도구 강제를 지원하지 않으면(11-06 오류 400) 자동 선택으로 바꿔요."""
    SCHEMAS.update(globals().get("SCHEMAS_EXTRA", {}))
    k = keys()
    if not k.get("anthropic"): return {"error": "Claude API 키가 없어요. 오른쪽 위 🔑 키 설정에서 넣어 주세요."}
    if isinstance(content, str): content = [{"type": "text", "text": content}]
    content = content + [{"type": "text", "text": "반드시 answer 도구를 한 번 호출해서 결과를 돌려줘요. 다른 말은 쓰지 마세요."}]
    body = {"model": k.get("model", "claude-sonnet-5-5"), "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}],
            "tools": [{"name": "answer", "description": "결과를 이 형식으로 돌려줘요.", "input_schema": SCHEMAS[schema]}]}
    try:
        global FORCE_OK
        for choice in (({"type": "tool", "name": "answer"},) if FORCE_OK else ()) + ({"type": "auto"},):
            try: r = _call({**body, "tool_choice": choice}); break
            except urllib.error.HTTPError as e:
                msg = e.read().decode()
                if e.code == 400 and "tool_choice" in msg and choice["type"] == "tool": FORCE_OK = False; continue
                return {"error": f"Claude API 오류 {e.code}: {msg[:300]}"}
        for b in r.get("content", []):
            if b.get("type") == "tool_use": return b.get("input", {})
        txt = "".join(b.get("text", "") for b in r.get("content", []) if b.get("type") == "text")
        try:
            j = _parse_text(txt)
            if j: return j
        except Exception: pass
        return {"error": "답 형식이 깨졌어요. 한 번 더 눌러 주세요."}
    except Exception as e:
        return {"error": f"Claude API 오류: {e}"}

def recommend(channel, topic, n_sent):
    ch = next((c for c in channels() if c["id"] == channel), None)
    if not ch: return {"error": "채널을 못 찾았어요"}
    prompt = (f"채널: {ch['name']}\n채널 규칙:\n{ch['rules']}\n\n"
              f"주제: {topic or '(채널에 맞는 새 주제를 추천해 줘)'}\n문장 수: 약 {n_sent}문장\n\n"
              "주제 후보(ideas) 3개와, 그중 첫 번째로 쓴 대본(script)을 answer 도구로 돌려줘. 문장마다 ko(한국어 대사), en(영어 자막), "
              "search(무료 실사 영상 Pexels/Pixabay 영어 검색어 1~3개, 실제로 있을 법한 구체적인 장면), fact_source(근거: 기관·논문·연도, 모르면 '확인 필요').")
    return claude(prompt, 6000, "recommend")

# ---------------------------------------------------------------- 사용 조건(11-06 "사용조건까지 다 고려해서 영상 추천") ----
# cond: free(조건 없음) < nasa(퍼블릭 도메인, 로고·제3자 주의) < by(출처 표시) < bysa(출처 + 같은 조건) ; review = 라이선스 검토 전
COND_KO = {"free": "조건 없음", "nasa": "퍼블릭 도메인(NASA 로고 금지)", "by": "출처 표시 필수", "bysa": "출처 + 같은 조건 표시", "review": "검토 전 — 원본 확인"}
COND_RANK = {"free": 0, "nasa": 1, "by": 2, "bysa": 3, "review": 4}
def cond_of(it):
    lic = (it.get("license") or "").lower()
    if "검토 전" in lic: return "review"
    if it["source"] in ("pexels", "pixabay"): return "free"
    if it["source"] == "nasa": return "nasa"
    if re.match(r"(public domain|pd|cc0)", lic): return "free"
    if "sa" in re.split(r"[\s-]", lic): return "bysa"
    return "by"
def allowed(it, level, review_ok):
    c = it["cond"]
    if c == "review" and not review_ok: return False
    if level == "free": return c in ("free", "nasa")
    return True
def annotate(items, level="attrib", review_ok=False):
    for it in items: it["cond"] = cond_of(it); it["cond_ko"] = COND_KO[it["cond"]]
    items = [it for it in items if allowed(it, level, review_ok)]
    items.sort(key=lambda it: COND_RANK[it["cond"]]); return items

def search(q, source, orient):
    k = keys(); out = []
    try:
        if source == "pexels":
            if not k.get("pexels"): return {"error": f"Pexels 키가 없어요. 🔑 키 설정에서 넣어 주세요."}
            u = "https://api.pexels.com/videos/search?" + urllib.parse.urlencode({"query": q, "per_page": 15, **({"orientation": orient} if orient else {})})
            for v in http_json(u, {"Authorization": k["pexels"]}).get("videos", []):
                fs = [f for f in v.get("video_files", []) if f.get("file_type") == "video/mp4" and f.get("width")]
                if not fs: continue
                best = min(fs, key=lambda f: abs(min(f["width"], f["height"]) - 1080))
                out.append({"source": "pexels", "id": str(v["id"]), "thumb": v.get("image"), "dur": v.get("duration"), "w": best["width"], "h": best["height"],
                            "dl": best["link"], "page": v.get("url"), "author": v.get("user", {}).get("name", ""), "license": "Pexels License",
                            "title": re.sub(r"[-/]", " ", (v.get("url") or "").rstrip("/").split("/")[-1]).rsplit(" ", 1)[0]})
        elif source == "pixabay":
            if not k.get("pixabay"): return {"error": f"Pixabay 키가 없어요. 🔑 키 설정에서 넣어 주세요."}
            u = "https://pixabay.com/api/videos/?" + urllib.parse.urlencode({"key": k["pixabay"], "q": q, "per_page": 15, "safesearch": "true"})
            for v in http_json(u).get("hits", []):
                vs = v.get("videos", {}); best = vs.get("large") if vs.get("large", {}).get("url") else vs.get("medium", {})
                out.append({"source": "pixabay", "id": str(v["id"]), "thumb": best.get("thumbnail") or vs.get("tiny", {}).get("thumbnail"), "dur": v.get("duration"),
                            "w": best.get("width"), "h": best.get("height"), "dl": best.get("url"), "page": v.get("pageURL"), "author": v.get("user", ""), "license": "Pixabay Content License", "title": v.get("tags", "")})
        elif source == "commons":   # 위키미디어 공용: 키 없음. 퍼블릭 도메인·CC0·CC BY·CC BY-SA만(출처 표시 필요)
            u = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode({"action": "query", "format": "json", "generator": "search", "gsrsearch": f"{q} filetype:video",
                "gsrnamespace": 6, "gsrlimit": 20, "prop": "imageinfo|categories", "cllimit": "max", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 320})
            pages = http_json(u, {"User-Agent": UA}).get("query", {}).get("pages", {})
            for pg in sorted(pages.values(), key=lambda x: x.get("index", 0)):
                ii = (pg.get("imageinfo") or [{}])[0]; em = ii.get("extmetadata", {})
                lic = re.sub("<[^>]+>", "", em.get("LicenseShortName", {}).get("value", "")).strip()
                if not re.match(r"(?i)(public domain|pd|cc0|cc[- ]by)", lic) or re.search(r"(?i)(^|[\s-])(nc|nd)([\s-]|$)", lic): continue
                if (ii.get("duration") or 99) < 3: continue
                out.append({"source": "commons", "id": str(pg["pageid"]), "thumb": ii.get("thumburl"), "dur": round(ii.get("duration") or 0, 1), "w": ii.get("width"), "h": ii.get("height"),
                            "dl": ii.get("url"), "page": ii.get("descriptionurl"), "author": re.sub("<[^>]+>", "", em.get("Artist", {}).get("value", ""))[:80].strip(),
                            "license": lic + (" ⚠검토 전" if any("license review" in c.get("title", "").lower() for c in pg.get("categories", [])) else ""), "title": pg.get("title", "")[5:]})
        elif source == "nasa":   # NASA 이미지·영상 라이브러리: 키 없음, 대부분 퍼블릭 도메인(NASA 로고·제3자 자료 제외)
            u = "https://images-api.nasa.gov/search?" + urllib.parse.urlencode({"q": q, "media_type": "video"})
            for it in http_json(u, {"User-Agent": UA}).get("collection", {}).get("items", [])[:15]:
                dt = (it.get("data") or [{}])[0]; th = next((l["href"] for l in it.get("links", []) if l.get("render") == "image"), None)
                out.append({"source": "nasa", "id": dt.get("nasa_id", ""), "thumb": th, "dur": None, "w": None, "h": None, "dl": it.get("href"),
                            "page": f"https://images.nasa.gov/details/{urllib.parse.quote(dt.get('nasa_id', ''))}", "author": dt.get("center", "NASA"),
                            "license": "NASA (public domain, check for third-party)", "title": dt.get("title", ""), "desc": (dt.get("description") or "")[:240]})
    except Exception as e:
        return {"error": f"검색 오류({source}): {e}"}
    return {"items": out}

def search_images(q, source):
    """사진·그림 검색(11-06 "여기에 쓸만한 사진 이미지 줘"). 결과는 영상 검색과 같은 모양 + kind=image."""
    k = keys(); out = []
    try:
        if source == "pixabay":
            if not k.get("pixabay"): return {"error": "Pixabay 키가 없어요."}
            u = "https://pixabay.com/api/?" + urllib.parse.urlencode({"key": k["pixabay"], "q": q, "image_type": "photo", "per_page": 20, "safesearch": "true"})
            for v in http_json(u).get("hits", []):
                out.append({"kind": "image", "source": "pixabay", "id": str(v["id"]), "thumb": v.get("webformatURL"), "w": v.get("imageWidth"), "h": v.get("imageHeight"),
                            "dl": v.get("largeImageURL"), "page": v.get("pageURL"), "author": v.get("user", ""), "license": "Pixabay Content License", "title": v.get("tags", "")})
        elif source == "commons":
            u = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode({"action": "query", "format": "json", "generator": "search", "gsrsearch": f"{q} filetype:bitmap",
                "gsrnamespace": 6, "gsrlimit": 20, "prop": "imageinfo|categories", "cllimit": "max", "iiprop": "url|size|mime|extmetadata", "iiurlwidth": 1920})
            for pg in sorted(http_json(u, {"User-Agent": UA}).get("query", {}).get("pages", {}).values(), key=lambda x: x.get("index", 0)):
                ii = (pg.get("imageinfo") or [{}])[0]; em = ii.get("extmetadata", {})
                lic = re.sub("<[^>]+>", "", em.get("LicenseShortName", {}).get("value", "")).strip()
                if not re.match(r"(?i)(public domain|pd|cc0|cc[- ]by)", lic) or re.search(r"(?i)(^|[\s-])(nc|nd)([\s-]|$)", lic): continue
                if (ii.get("width") or 0) < 1000: continue
                out.append({"kind": "image", "source": "commons", "id": str(pg["pageid"]), "thumb": ii.get("thumburl"), "w": ii.get("width"), "h": ii.get("height"),
                            "dl": ii.get("thumburl") or ii.get("url"), "page": ii.get("descriptionurl"), "author": re.sub("<[^>]+>", "", em.get("Artist", {}).get("value", ""))[:80].strip(),
                            "license": lic + (" ⚠검토 전" if any("license review" in c.get("title", "").lower() for c in pg.get("categories", [])) else ""), "title": pg.get("title", "")[5:]})
        elif source == "nasa":
            u = "https://images-api.nasa.gov/search?" + urllib.parse.urlencode({"q": q, "media_type": "image"})
            for it in http_json(u, {"User-Agent": UA}).get("collection", {}).get("items", [])[:15]:
                dt = (it.get("data") or [{}])[0]; th = next((l["href"] for l in it.get("links", []) if l.get("render") == "image"), None)
                out.append({"kind": "image", "source": "nasa", "id": dt.get("nasa_id", ""), "thumb": th, "dl": it.get("href"), "page": f"https://images.nasa.gov/details/{urllib.parse.quote(dt.get('nasa_id', ''))}",
                            "author": dt.get("center", "NASA"), "license": "NASA (public domain, check for third-party)", "title": dt.get("title", ""), "desc": (dt.get("description") or "")[:200]})
    except Exception as e:
        return {"error": f"사진 검색 오류({source}): {e}"}
    return {"items": out}

def sent_search(text, topic, channel, kind, level, review_ok, note=""):
    """문장(자막) 하나에 맞는 영상/사진 후보: Claude가 문장을 보고 검색어를 만들고, 사용 조건대로 여러 출처에서 찾아요."""
    SCHEMAS.update(SCHEMAS_EXTRA)
    kws = [{"q": topic or text, "why": "주제"}]
    r = claude(f"쇼츠 주제: {topic}\n이 문장(내레이션)에 맞는 화면을 무료 {'실사 영상' if kind == 'video' else '사진'}(Pixabay·위키미디어·NASA·Pexels)에서 찾으려고 해요.\n"
               f"문장: {text}\n" + (f"사용자 요청: {note}\n" if note else "") +
               "실제로 그런 자료가 있을 법한 구체적인 영어 검색어 5개를 만들고, why에 어떤 장면인지 한국어로 짧게. 문장의 동물·현상과 같은 종·같은 장면을 우선. answer 도구로 돌려줘.", 900, "similar")
    if r.get("keywords"): kws = r["keywords"][:5]
    k = keys(); srcs = [x for x in ("pixabay", "pexels") if k.get(x)] + ["commons", "nasa"]
    if kind == "image": srcs = [x for x in ("pixabay",) if k.get(x)] + ["commons", "nasa"]
    out, seen = [], set()
    for kw in kws:
        for src in srcs:
            res = search(kw["q"], src, "") if kind == "video" else search_images(kw["q"], src)
            for it in annotate(res.get("items", []), level, review_ok)[:3]:
                key = it["source"] + str(it["id"])
                if key in seen: continue
                seen.add(key); it["kw"] = kw["q"]; it["why"] = kw.get("why", ""); it.setdefault("kind", "video"); out.append(it)
    out.sort(key=lambda it: COND_RANK[it["cond"]])
    return {"keywords": kws, "items": out, "error": r.get("error")}

SCHEMAS_VEO = {
  "veo": {"type": "object", "properties": {"prompt_en": S_STR, "shot_ko": S_STR, "camera_ko": S_STR, "light_ko": S_STR, "avoid_en": S_STR,
          "checklist_ko": {"type": "array", "items": S_STR}, "tips_ko": {"type": "array", "items": S_STR}}, "required": ["prompt_en", "checklist_ko"]},
  "veo_check": {"type": "object", "properties": {"pass": {"type": "boolean"}, "score": {"type": "integer"}, "good_ko": {"type": "array", "items": S_STR},
          "issues_ko": {"type": "array", "items": S_STR}, "fix_prompt_en": S_STR}, "required": ["pass", "score", "issues_ko"]}}
def veo_prompt(text, topic, prev, nxt, note):
    """✨ 이 문장에 맞는 Veo(Flow) 프롬프트: 장면·클로즈업·카메라·빛·피할 것 + 검수 목록."""
    SCHEMAS.update(SCHEMAS_VEO)
    return claude(f"쇼츠 주제: {topic}\n앞 문장: {prev}\n이 문장: {text}\n뒤 문장: {nxt}\n" + (f"사용자 요청: {note}\n" if note else "") +
        "이 문장 화면으로 쓸 Google Veo 3.1(Flow) 영상 프롬프트를 영어로 써 줘. 세로 9:16, 8초, 사실적인 자연 다큐 실사 느낌, 글자·로고·워터마크 없음, 사람 얼굴 없음. "
        "프롬프트 안에 샷 크기(익스트림 클로즈업/클로즈업/미디엄/와이드), 카메라 움직임(느린 달리 인·고정·트래킹 등), 렌즈 느낌, 빛, 동물의 정확한 생김새(종의 특징)를 구체적으로. "
        "shot_ko·camera_ko·light_ko는 한국어 설명, avoid_en은 넣지 말아야 할 것(negative), checklist_ko는 만들어진 영상을 검수할 항목(종 특징이 맞는지, 손발 수, 물리적으로 이상한 움직임, 글자 생김 등) 5~7개, "
        "tips_ko는 Flow에서 더 잘 나오게 하는 요령 2~3개. answer 도구로 돌려줘.", 1800, "veo")
def veo_check(mid, text, prompt, checklist):
    """🔍 Veo로 만든 클립 검수: 장면 4장을 보고 문장·프롬프트·검수 목록과 맞는지, AI 티(손발·물리·글자)가 나는지."""
    SCHEMAS.update(SCHEMAS_VEO)
    if mid not in DB: return {"error": "클립을 못 찾았어요"}
    content = [{"type": "text", "text": f"쇼츠 문장: {text}\nVeo 프롬프트: {prompt}\n검수 목록: {'; '.join(checklist or [])}\n"
                "아래는 이 프롬프트로 만든 AI 영상의 장면 4장이에요. 자연 다큐 쇼츠에 써도 될지 엄격하게 검수해 줘: 종의 특징이 실제와 맞는지, 몸 구조·다리·지느러미 수, 물리적으로 이상한 움직임·녹아내림, "
                "글자·워터마크, 문장 내용과 맞는지. score 0~100, pass는 70 이상이면 true, issues_ko·good_ko는 한국어, fix_prompt_en은 고친 프롬프트. answer 도구로 돌려줘."}]
    for b in frames_b64(mid, 4): content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b}})
    return claude(content, 1500, "veo_check")

WONDER = ["bioluminescence", "murmuration starlings", "mimic octopus", "cuttlefish color change", "volcano lava flow", "aurora timelapse", "jellyfish swarm",
          "coral spawning", "humpback whale breach", "slime mold timelapse", "lightning storm slow motion", "glacier calving", "sardine run", "manta ray",
          "hummingbird slow motion", "mantis shrimp", "firefly synchronous", "sea otter", "chameleon tongue", "leafcutter ants", "geyser eruption", "sand dunes wind",
          "space station earth view", "solar flare", "comet", "deep sea creature", "seahorse", "fungi growth timelapse", "dragonfly emerging", "salmon run"]
def wonder(n_kw=6, level="attrib", review_ok=False):
    """✨ 신기한 영상 둘러보기: 신기한 자연 현상 검색어 몇 개를 골라 모든 무료 출처에서 찾아요."""
    import random
    k = keys(); srcs = ["commons", "nasa"] + [x for x in ("pixabay", "pexels") if k.get(x)]
    out = []
    for kw in random.sample(WONDER, n_kw):
        for src in srcs:
            items = annotate(search(kw, src, "").get("items", []), level, review_ok)[:3]
            for it in items: it["kw"] = kw
            out += items
    random.shuffle(out); out.sort(key=lambda it: COND_RANK[it["cond"]]); return {"items": out, "sources": srcs}

UA = "sumgyeol-editor/1.0 (personal shorts editor)"
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"

SCHEMAS_EXTRA = {"similar": {"type": "object", "properties": {"subject": S_STR, "keywords": {"type": "array", "items": {"type": "object", "properties": {
    "q": S_STR, "why": S_STR}, "required": ["q", "why"]}}}, "required": ["keywords"]}}
def similar(mid, level="attrib", review_ok=False):
    """🔗 고른 영상과 비슷하거나 이어 붙이기 좋은 영상 찾기(11-06): Claude가 장면을 보고 검색어를 만들고, 사용 조건을 지켜 여러 출처에서 찾아요."""
    SCHEMAS.update(SCHEMAS_EXTRA)
    m = DB.get(mid)
    if not m: return {"error": "영상을 못 찾았어요"}
    cr = m.get("credit") or {}
    kws = []; subject = cr.get("ko") or cr.get("title") or ""
    if keys().get("anthropic") and m["kind"] == "video":
        content = [{"type": "text", "text": f"이 영상(파일 {m['name']}, 출처 설명: {cr.get('ko') or ''} {cr.get('title') or ''})의 장면 3장이에요. "
                    "이 영상 앞뒤에 이어 붙이기 좋은 무료 실사 영상을 찾을 영어 검색어 6개를 만들어 줘: 같은 대상의 다른 각도·가까이, 같은 대상이 다음에 하는 행동, "
                    "사는 곳·주변 환경 넓은 장면, 관련된 다른 생물·현상. why는 한국어로 짧게(예: '같은 해달 가까이'). subject는 영상 속 대상 한국어 이름. answer 도구로 돌려줘."}]
        for b in frames_b64(mid): content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b}})
        r = claude(content, 1200, "similar")
        if r.get("keywords"): kws = r["keywords"][:6]; subject = r.get("subject") or subject
    if not kws:   # 키가 없으면 제목·태그 낱말로
        base = (cr.get("title") or os.path.splitext(m["name"])[0]).replace(",", " ")
        words = [w for w in re.split(r"[\s_\-]+", base) if len(w) > 2 and not w.isdigit()][:3]
        q = " ".join(words) or base
        kws = [{"q": q, "why": "같은 대상"}, {"q": q + " close up", "why": "가까이"}, {"q": q + " underwater" if "sea" in q.lower() else q + " wide", "why": "넓은 장면"}]
    k = keys(); srcs = [x for x in ("pixabay", "pexels") if k.get(x)] + ["commons", "nasa"]
    have = {(DB[i].get("credit") or {}).get("source", "") + str((DB[i].get("credit") or {}).get("id", "")) for i in DB}
    out, seen = [], set()
    for kw in kws:
        for src in srcs:
            for it in annotate(search(kw["q"], src, "").get("items", []), level, review_ok)[:2]:
                key = it["source"] + str(it["id"])
                if key in seen or key in have: continue
                seen.add(key); it["kw"] = kw["q"]; it["why"] = kw.get("why", ""); out.append(it)
    out.sort(key=lambda it: COND_RANK[it["cond"]])
    return {"subject": subject, "keywords": kws, "items": out}
def nasa_file(href, kind="video"):
    """NASA 항목의 파일 목록에서 가장 알맞은 파일(영상 mp4 / 그림 jpg, orig > large > medium)을 골라요."""
    files = http_json(href, {"User-Agent": UA})
    mp4 = [f for f in files if f.lower().endswith((".mp4",) if kind == "video" else (".jpg", ".jpeg", ".png"))]
    for tag in ("~orig", "~large", "~medium", ""):
        for f in mp4:
            if tag in f: return f.replace("http://", "https://")
    raise RuntimeError("mp4가 없어요")

def fetch(item, folder=None):
    """고른 영상을 받아 미디어로 가져오고, 출처를 credits.json에 적어요. folder = sources 안 편 폴더 이름."""
    d = os.path.join(SOURCES, folder) if folder else DL; os.makedirs(d, exist_ok=True)
    kind = item.get("kind", "video")
    dl = nasa_file(item["dl"], kind) if item["source"] == "nasa" else item["dl"]
    ext = os.path.splitext(urllib.parse.urlparse(dl).path)[1].lower() or (".mp4" if kind == "video" else ".jpg")
    if kind == "video" and ext not in VIDEO_EXT: ext = ".mp4"
    if kind == "image" and ext not in IMAGE_EXT: ext = ".jpg"
    name = f"{item['source']}_{SAFE.sub('_', str(item['id']))[:60]}{ext}"; dst = os.path.join(d, name)
    if not os.path.exists(dst):
        req = urllib.request.Request(dl, headers={"User-Agent": UA if item["source"] in ("commons", "nasa") else BROWSER_UA})
        with urllib.request.urlopen(req, timeout=600) as r, open(dst + ".part", "wb") as f: shutil.copyfileobj(r, f, 1 << 20)
        os.replace(dst + ".part", dst)
    cf = os.path.join(d, "credits.json")
    cr = json.load(open(cf, encoding="utf-8")) if os.path.exists(cf) else {}
    item.setdefault("cond", cond_of(item))
    cr[name] = {k_: item.get(k_) for k_ in ("source", "id", "page", "author", "license", "title", "ko", "cond")}
    json.dump(cr, open(cf, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    ids = import_paths([dst])
    for i in ids: DB[i]["credit"] = cr[name]
    save_db(); return ids

# ---------------------------------------------------------------- 영상 먼저 → 대본 (11-06 "영상을 찾아서 - 대본을 추천하는 방식으로") ----
COLLECT = {}   # 진행 상황
def collect(channel, topic, n, orient, folder, level="attrib", review_ok=False):
    """① 주제로 검색어를 만들고(Claude, 키 없으면 주제 그대로) Pexels/Pixabay에서 영상을 모아 sources\\<folder>\\ 에 받아요."""
    COLLECT[folder] = {"state": "검색어 만드는 중", "ids": [], "done": False}
    kws = [topic]
    ch = next((c for c in channels() if c["id"] == channel), {"name": channel, "rules": ""})
    r = claude(f"채널 {ch['name']}의 쇼츠 주제: {topic}\n이 주제의 쇼츠에 쓸 무료 실사 영상(Pexels·Pixabay)을 찾을 영어 검색어 8개를 만들어 줘. "
               "주인공 동물·장소·행동·관련 생물·환경을 고르게, 실제로 영상이 있을 법한 구체적인 말로. answer 도구로 돌려줘.", 800, "keywords")
    if r.get("keywords"): kws = r["keywords"][:8]
    COLLECT[folder]["keywords"] = kws
    per = max(1, -(-n // len(kws))); got = set(); k = keys()
    for kw in kws:
        for src in ("pixabay", "pexels", "commons", "nasa"):
            if src in ("pixabay", "pexels") and not k.get(src): continue
            COLLECT[folder]["state"] = f"찾는 중: {kw} ({src})"
            res = annotate(search(kw, src, orient).get("items", []) or search(kw, src, "").get("items", []), level, review_ok)
            c = 0
            for it in res:
                if c >= per or len(COLLECT[folder]["ids"]) >= n: break
                key = it["source"] + it["id"]
                if key in got or (it.get("dur") or 0) < 4: continue
                got.add(key); COLLECT[folder]["state"] = f"받는 중 {len(COLLECT[folder]['ids']) + 1}/{n}: {kw}"
                try: COLLECT[folder]["ids"] += fetch(it, folder); c += 1
                except Exception: pass
            break   # 한 검색어당 첫 번째로 되는 사이트만
    COLLECT[folder].update(state=f"다 모았어요({len(COLLECT[folder]['ids'])}개)", done=True)

def frames_b64(mid, k=3):
    """클립에서 k장 뽑아 base64 JPEG(가로 320)."""
    import base64, tempfile
    m = DB[mid]; src = os.path.join(MED, mid, "proxy.mp4"); out = []
    for i in range(k):
        t = m["dur"] * (i + 1) / (k + 1)
        fd, tmp = tempfile.mkstemp(suffix=".jpg"); os.close(fd)
        run(["-ss", f"{t:.2f}", "-i", src, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", tmp])
        try: out.append(base64.b64encode(open(tmp, "rb").read()).decode())
        except Exception: pass
        os.remove(tmp)
    return out

def script_from_media(channel, topic, ids, n_sent):
    """② 모은 영상의 장면을 Claude가 직접 보고, 그 영상들로 보여 줄 수 있는 대본을 문장마다 클립을 붙여 추천해요."""
    ch = next((c for c in channels() if c["id"] == channel), None)
    if not ch: return {"error": "채널을 못 찾았어요"}
    vids = [i for i in ids if i in DB and DB[i]["kind"] == "video" and DB[i].get("status") == "ready"][:20]
    if not vids: return {"error": "대본을 만들 영상이 없어요. 먼저 영상을 모으거나 가져오세요."}
    content = [{"type": "text", "text": f"채널: {ch['name']}\n채널 규칙:\n{ch['rules']}\n\n주제: {topic or '(영상을 보고 가장 좋은 주제를 골라 줘)'}\n"
                f"아래 영상 클립 {len(vids)}개(각 3장, 앞·가운데·뒤)를 보고, 이 영상들로 화면을 채울 수 있는 쇼츠 대본을 약 {n_sent}문장으로 써 줘.\n"
                "- 문장마다 가장 잘 맞는 클립 번호(C1…)와 그 클립에서 쓸 시작 초(clip_in)를 골라. 같은 클립을 여러 번 써도 되지만 연달아 쓰지는 마.\n"
                "- 영상에 보이는 것과 대사가 어긋나지 않게. 영상 속 동물이 주제와 다른 종이면 그렇다고 clips_note에 적어.\n"
                "- 사실은 널리 확인된 것만, 문장마다 근거(기관·논문·연도)를 적고, 확실하지 않으면 fact_source에 '확인 필요'.\n"
                "answer 도구로 돌려줘: title, hook(첫 문장), clips_note(클립마다 보이는 것 한 줄과 주제 종이 맞는지), sentences(ko, en, clip, clip_in, fact_source)."}]
    for j, mid in enumerate(vids):
        cr = DB[mid].get("credit") or {}
        content.append({"type": "text", "text": f"C{j + 1}: {DB[mid]['name']} ({DB[mid]['dur']:.1f}초)" + (f" · 출처 설명: {cr.get('ko') or ''} {cr.get('title') or ''}" if cr else "")})
        for b in frames_b64(mid): content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b}})
    r = claude(content, 8000, "media_script")
    if r.get("sentences"):
        for x in r["sentences"]:
            try: x["media"] = vids[int(str(x.get("clip", "C1")).lstrip("Cc")) - 1]
            except Exception: x["media"] = None
        for x in r.get("clips_note", []):
            try: x["media"] = vids[int(str(x.get("clip", "C1")).lstrip("Cc")) - 1]
            except Exception: pass
    return r

LIC_URL = {"cc by 2.0": "https://creativecommons.org/licenses/by/2.0/", "cc by 2.5": "https://creativecommons.org/licenses/by/2.5/", "cc by 3.0": "https://creativecommons.org/licenses/by/3.0/",
           "cc by 4.0": "https://creativecommons.org/licenses/by/4.0/", "cc by-sa 2.0": "https://creativecommons.org/licenses/by-sa/2.0/", "cc by-sa 3.0": "https://creativecommons.org/licenses/by-sa/3.0/",
           "cc by-sa 4.0": "https://creativecommons.org/licenses/by-sa/4.0/"}
def credits_text(folder):
    """업로드 설명란용 출처 문구. 출처 표시가 필요한 것(CC BY·BY-SA)은 작가·라이선스·링크를 꼭, 나머지는 한 줄로 묶어요."""
    cf = os.path.join(SOURCES, folder, "credits.json")
    if not os.path.exists(cf): return "(이 폴더에서 받은 영상의 출처 기록이 없어요)"
    cr = json.load(open(cf, encoding="utf-8")); must, free = [], {}
    for name, c in cr.items():
        cond = c.get("cond") or "free"
        if cond in ("by", "bysa", "review"):
            lic = (c.get("license") or "").replace(" ⚠검토 전", ""); url = LIC_URL.get(lic.lower().strip(), "")
            must.append(f'- "{c.get("title") or name}" — {c.get("author") or "작가 미상"}, {lic}{" (" + url + ")" if url else ""}, {c.get("page") or ""}{" · 편집됨" if cond != "free" else ""}')
        else:
            src = {"pexels": "Pexels", "pixabay": "Pixabay", "nasa": "NASA", "commons": "Wikimedia Commons(퍼블릭 도메인)"}.get(c.get("source"), c.get("source"))
            free.setdefault(src, []).append(str(c.get("id")))
    lines = ["[영상 출처]"] + must + [f"- {src}: {', '.join(ids)}" for src, ids in free.items()]
    if any("sa" in (c.get("license") or "").lower().split("-") or "by-sa" in (c.get("license") or "").lower() for c in cr.values()):
        lines.append("※ CC BY-SA 영상을 고친 부분은 같은 라이선스(CC BY-SA)를 따릅니다.")
    return "\n".join(lines)

# ---------------------------------------------------------------- Claude 초안 프로젝트의 자동 받기(11-06 "너가 일차적으로 취합해서 만들고 내가 편집") ----
PREFETCH = {"state": "", "done": True, "n": 0, "i": 0, "fail": []}
def prefetch(items):
    """프로젝트의 fetch 목록: [{src: 'sources/폴더/파일', url, credit}] — 없는 파일만 받아 그 자리에 두고 출처를 기록해요."""
    PREFETCH.update(state="받는 중", done=False, n=len(items), i=0, fail=[])
    for it in items:
        PREFETCH["i"] += 1
        dst = abs_of(it["src"])
        if os.path.exists(dst): continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        PREFETCH["state"] = f"받는 중 {PREFETCH['i']}/{len(items)}: {os.path.basename(dst)}"
        try:
            url = it["url"]
            if url.startswith("nasa:"): url = nasa_file(url[5:])
            req = urllib.request.Request(url, headers={"User-Agent": UA if "wikimedia" in url or "nasa" in url else BROWSER_UA})
            with urllib.request.urlopen(req, timeout=900) as r, open(dst + ".part", "wb") as f: shutil.copyfileobj(r, f, 1 << 20)
            os.replace(dst + ".part", dst)
            if it.get("credit"):
                cf = os.path.join(os.path.dirname(dst), "credits.json"); cr = json.load(open(cf, encoding="utf-8")) if os.path.exists(cf) else {}
                cr[os.path.basename(dst)] = it["credit"]; json.dump(cr, open(cf, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        except Exception as e:
            PREFETCH["fail"].append(f"{os.path.basename(dst)}: {e}")
    PREFETCH.update(state=f"다 받았어요({len(items) - len(PREFETCH['fail'])}/{len(items)})", done=True)

# ---------------------------------------------------------------- 목소리(TTS) ----
SCHEMAS_TTS = {"reading": {"type": "object", "properties": {"speak": S_STR}, "required": ["speak"]}}
_KN = "영일이삼사오육칠팔구"
def _sino(n):
    if n == 0: return "영"
    out = ""; units = [(100000000, "억"), (10000, "만")]
    def four(x):
        r = ""; 
        for v, u in ((1000, "천"), (100, "백"), (10, "십"), (1, "")):
            d = x // v; x %= v
            if d: r += ("" if d == 1 and u else _KN[d]) + u
        return r
    for v, u in units:
        if n >= v: out += four(n // v) + u; n %= v
    return out + four(n)
def naive_reading(t):
    t = re.sub(r"(\d+)\s*%", lambda m: _sino(int(m.group(1))) + " 퍼센트", t)
    t = re.sub(r"(\d+)\s*~\s*(\d+)", lambda m: _sino(int(m.group(1))) + "에서 " + _sino(int(m.group(2))), t)
    t = re.sub(r"(\d+)\.(\d+)", lambda m: _sino(int(m.group(1))) + " 점 " + " ".join(_KN[int(c)] for c in m.group(2)), t)
    return re.sub(r"\d+", lambda m: _sino(int(m.group(0))), t)
def reading_of(text):
    if not re.search(r"\d", text): return text
    if keys().get("anthropic"):
        SCHEMAS.update(SCHEMAS_TTS)
        r = claude("한국어 내레이션 문장을 TTS가 정확히 읽도록 '읽는 대로' 바꿔 줘. 숫자·단위·기호를 한글로(예: 1970년대→천구백칠십년대, 3마리→세 마리, 15만→십오만, 2~3년→이삼 년, 90%→구십 퍼센트, 1제곱센티미터→일 제곱센티미터, 4분의 1→사분의 일). "
                   "다른 낱말은 바꾸지 말고 문장부호는 그대로. answer 도구로 speak만 돌려줘.\n문장: " + text, 600, "reading")
        if r.get("speak"): return r["speak"]
    return naive_reading(text)
def tts_make(text, speak, folder, sid=7, speed=1.15, tempo=0.94):
    import tts_local, hashlib
    speak = (speak or "").strip() or reading_of(text)
    d = os.path.join(SOURCES, folder or "_목소리", "voice"); os.makedirs(d, exist_ok=True)
    h = hashlib.md5(f"{speak}|{sid}|{speed}|{tempo}".encode()).hexdigest()[:10]; out = os.path.join(d, f"v_{h}.wav")
    if not os.path.exists(out):
        raw = os.path.join(DATA, f"tts_{h}_raw.wav"); tts_local.synth(DATA, speak, raw, sid, speed)
        # 앞뒤 무음 자르기 + 8번 목소리 템포(0.94) + 48kHz
        r = run(["-i", raw, "-af", f"silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.06,areverse,atempo={tempo}",
                 "-ar", "48000", "-ac", "1", out])
        try: os.remove(raw)
        except Exception: pass
        if r.returncode: raise RuntimeError(r.stderr[-300:])
    ids = import_paths([out])
    for i in ids: DB[i]["credit"] = {"source": "claude", "license": "직접 제작(Supertonic TTS, 8번 목소리)", "title": text[:40], "cond": "free"}
    save_db(); return {"id": ids[0], "speak": speak, "dur": probe(out)["dur"]}

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
        if p == "/api/export_upload":   # 미리보기 녹화(webm)를 받아 mp4로 바꿔 저장하고 열어 줘요
            q = parse_qs(urlparse(self.path).query); name = SAFE.sub("_", q.get("name", ["미리보기"])[0]).strip() or "미리보기"
            folder = SAFE.sub("_", q.get("folder", [""])[0]).strip(); d = os.path.join(SOURCES, folder) if folder else os.path.join(SOURCES, "_미리보기"); os.makedirs(d, exist_ok=True)
            webm = os.path.join(DATA, f"rec_{int(time.time())}.webm"); left = int(self.headers.get("Content-Length", 0) or 0)
            with open(webm, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk: break
                    f.write(chunk); left -= len(chunk)
            out = os.path.join(d, f"미리보기_{name}.mp4")
            r = run(["-i", webm, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out])
            try: os.remove(webm)
            except Exception: pass
            if r.returncode: return self._json({"error": r.stderr[-300:]}, 500)
            log(f"preview exported {out}")
            if os.name == "nt":
                try: os.startfile(out)
                except Exception: pass
            return self._json({"ok": True, "path": rel_of(out) or out})
        if p == "/api/pick": return self._json({"ids": import_paths(pick_files())})
        if p == "/api/import": return self._json({"ids": import_paths(self._body().get("paths", []))})
        if p == "/api/inbox":   # GitHub inbox/의 Claude 초안 목록(아직 projects에 없는 것)
            try:
                req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/contents/inbox?ref=main", headers={"User-Agent": "sumgyeol-editor"})
                with urllib.request.urlopen(req, timeout=10) as r: lst = json.loads(r.read().decode())
                names = [f["name"][:-5] for f in lst if f["name"].endswith(".shum")]
                return self._json({"items": [{"name": n, "have": os.path.exists(proj_path(n))} for n in names]})
            except Exception as e: return self._json({"items": [], "error": str(e)})
        if p == "/api/inbox/take":   # 초안을 받아 projects에 저장
            n = self._body().get("name", "")
            try:
                sha = REMOTE_SHA or "main"
                with urllib.request.urlopen(f"https://raw.githubusercontent.com/{REPO}/{sha}/inbox/{urllib.parse.quote(n)}.shum", timeout=20) as r: j = json.loads(r.read().decode())
            except Exception:
                with urllib.request.urlopen(f"https://raw.githubusercontent.com/{REPO}/main/inbox/{urllib.parse.quote(n)}.shum?t={time.time()}", timeout=20) as r: j = json.loads(r.read().decode())
            f = proj_path(n)
            if os.path.exists(f): os.replace(f, f[:-5] + time.strftime("_%m%d%H%M") + ".shum.bak")   # 이미 있으면 백업
            json.dump(j, open(f, "w", encoding="utf-8"), ensure_ascii=False, indent=1); return self._json({"ok": True, "name": n})
        if p == "/api/prefetch":
            items = self._body().get("fetch", [])
            if PREFETCH["done"]: threading.Thread(target=prefetch, args=(items,), daemon=True).start()
            return self._json({"ok": True})
        if p == "/api/prefetch/status": return self._json(PREFETCH)
        if p == "/api/resolve":   # 다른 PC에서 만든 프로젝트: 클립의 src(01_쇼츠 기준 상대 경로)로 다시 가져오기
            out = {}
            for src in self._body().get("srcs", []):
                ids = import_paths([src]); out[src] = ids[0] if ids else None
                cf = os.path.join(os.path.dirname(abs_of(src)), "credits.json")   # 받은 출처를 미디어에 붙여요
                if ids and os.path.exists(cf):
                    c = json.load(open(cf, encoding="utf-8")).get(os.path.basename(src))
                    if c: DB[ids[0]]["credit"] = c; save_db()
            return self._json(out)
        if p == "/api/project":
            j = self._body(); f = proj_path(j.get("name", "제목없음")); tmp = f + ".tmp"
            json.dump(j, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1); os.replace(tmp, f)
            return self._json({"ok": True, "path": f})
        if p == "/api/keys/set":   # 편집기 화면에서 키 넣기 → 이 PC의 키 파일에만 저장(밖으로 안 나감)
            j = self._body(); k = keys()
            for n in ("anthropic", "pexels", "pixabay"):
                v = (j.get(n) or "").strip()
                if v: k[n] = v
            json.dump(k, open(KEYF, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            return self._json({n: bool(k.get(n)) for n in ("anthropic", "pexels", "pixabay")})
        if p == "/api/update/apply":
            try: changed = apply_update()
            except Exception as e: log(f"update failed: {e}"); return self._json({"error": f"업데이트 실패: {e}"}, 500)
            need = any(c.endswith(".py") for c in changed)   # 화면 파일만 바뀌면 서버는 그대로, 새로고침만
            self._json({"ok": True, "version": local_version(), "restart": need})
            if need: log("restarting for " + ", ".join(c for c in changed if c.endswith('.py'))); threading.Thread(target=restart, daemon=True).start()
            return
        if p == "/api/collect":
            j = self._body(); folder = SAFE.sub("_", j.get("folder") or j.get("topic", "새주제")).strip()
            if COLLECT.get(folder, {}).get("done") is False: return self._json({"folder": folder, "busy": True})
            threading.Thread(target=collect, args=(j.get("channel", "jigu"), j.get("topic", ""), int(j.get("n", 12)), j.get("orient", ""), folder, j.get("level", "attrib"), bool(j.get("review"))), daemon=True).start()
            return self._json({"folder": folder})
        if p == "/api/save_script":   # 대본을 sources\<folder>\대본.json·대본.txt로 저장(Claude가 내레이션 만들 때 읽어요)
            j = self._body(); folder = SAFE.sub("_", j.get("folder", "새주제")).strip(); d = os.path.join(SOURCES, folder); os.makedirs(d, exist_ok=True)
            sc = j.get("script", {}); json.dump(sc, open(os.path.join(d, "대본.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            lines = [sc.get("title", "")] + [f"{i + 1}. {x.get('ko', '')}\n   EN: {x.get('en', '')}\n   화면: {x.get('clip', '')} {x.get('clip_in', 0)}초 / 근거: {x.get('fact_source', '')}" for i, x in enumerate(sc.get("sentences", []))]
            open(os.path.join(d, "대본.txt"), "w", encoding="utf-8").write("\n".join(lines)); return self._json({"ok": True, "path": d})
        if p == "/api/collect/status": j = self._body(); return self._json(COLLECT.get(j.get("folder"), {}))
        if p == "/api/script_from_media":
            j = self._body(); return self._json(script_from_media(j.get("channel"), j.get("topic", ""), j.get("ids", []), int(j.get("n", 14))))
        if p == "/api/recommend":
            j = self._body(); return self._json(recommend(j.get("channel"), j.get("topic", ""), int(j.get("n", 14))))
        if p == "/api/search":
            j = self._body(); r = search(j.get("q", ""), j.get("source", "pixabay"), j.get("orient", ""))
            if "items" in r: r["items"] = annotate(r["items"], j.get("level", "attrib"), bool(j.get("review")))
            return self._json(r)
        if p == "/api/wonder": j = self._body(); return self._json(wonder(6, j.get("level", "attrib"), bool(j.get("review"))))
        if p == "/api/credits_text":   # 업로드 설명란에 붙일 출처 문구(이 폴더에서 받은 것 전부)
            folder = self._body().get("folder") or "_받은영상"; return self._json({"text": credits_text(folder)})
        if p == "/api/similar": j = self._body(); return self._json(similar(j.get("id"), j.get("level", "attrib"), bool(j.get("review"))))
        if p == "/api/sent_search":
            j = self._body(); return self._json(sent_search(j.get("text", ""), j.get("topic", ""), j.get("channel", "jigu"), j.get("kind", "video"), j.get("level", "attrib"), bool(j.get("review")), j.get("note", "")))
        if p == "/api/veo_prompt":
            j = self._body(); return self._json(veo_prompt(j.get("text", ""), j.get("topic", ""), j.get("prev", ""), j.get("next", ""), j.get("note", "")))
        if p == "/api/veo_check":
            j = self._body(); return self._json(veo_check(j.get("id"), j.get("text", ""), j.get("prompt", ""), j.get("checklist", [])))
        if p == "/api/tts":
            j = self._body()
            try: return self._json(tts_make(j.get("text", ""), j.get("speak", ""), j.get("folder", ""), int(j.get("sid", 7)), float(j.get("speed", 1.15)), float(j.get("tempo", 0.94))))
            except Exception as e: log(f"tts error {e}"); return self._json({"error": f"목소리 만들기 오류: {e}"}, 500)
        if p == "/api/tts/status":
            import tts_local; return self._json(tts_local.STATE)
        if p == "/api/describe": return self._json(describe(self._body().get("items", [])[:40]))
        if p == "/api/fetch_pexels":   # API 키 없이: Pexels 영상 주소/번호로 바로 받기(11-06 Pexels 새 키 발급 중단)
            j = self._body(); m = re.findall(r"(\d{5,})", j.get("url", ""))
            if not m: return self._json({"error": "주소에서 영상 번호를 못 찾았어요"}, 400)
            vid = m[-1]; page = j.get("url") if "pexels.com" in j.get("url", "") else f"https://www.pexels.com/video/{vid}/"
            try: return self._json({"ids": fetch({"source": "pexels", "id": vid, "dl": f"https://www.pexels.com/download/video/{vid}/", "page": page, "author": "", "license": "Pexels License"}, j.get("folder") or None)})
            except Exception as e: return self._json({"error": f"받기 오류: {e}"}, 500)
        if p == "/api/fetch":
            try: j = self._body(); return self._json({"ids": fetch(j, j.get("folder") or None)})
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
    z = zipfile.ZipFile(io.BytesIO(data)); top = z.namelist()[0].split("/")[0]; changed = []
    for n in z.namelist():
        if n.endswith("/"): continue
        rel = n[len(top) + 1:]
        if not rel or rel.startswith("projects/") or rel.startswith("inbox/"): continue   # inbox = Claude 초안 재료(편집기 폴더에 안 넣음)
        dst = os.path.join(ROOT, *rel.split("/"))
        if rel == "START.bat": dst = os.path.join(ROOT, "START.new.bat")   # 실행 중인 bat은 안 건드림
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        data_n = z.read(n)
        try:
            if open(dst, "rb").read() == data_n: continue   # 같으면 건드리지 않음
        except Exception: pass
        changed.append(rel)
        for k_ in range(10):   # 구글 드라이브가 잠깐 잠가도 다시 시도
            try:
                with open(dst + ".tmp", "wb") as f: f.write(data_n)
                os.replace(dst + ".tmp", dst); break
            except PermissionError: time.sleep(0.5)
        else: raise RuntimeError(f"{rel}을(를) 쓸 수 없어요(드라이브가 잠금 중)")
    sb, nb = os.path.join(ROOT, "START.bat"), os.path.join(ROOT, "START.new.bat")
    if os.path.exists(nb) and os.path.exists(sb) and open(sb, "rb").read() == open(nb, "rb").read(): os.remove(nb)
    log("update applied: " + ", ".join(changed)); return changed

RESTART = False
def restart():   # 응답을 보낸 뒤 서버를 멈추고 종료 코드 3으로 나가요 → 감독 프로세스가 새 코드로 다시 켜요
    global RESTART
    time.sleep(0.5); RESTART = True; SERVER.shutdown()
LOGF = os.path.join(DATA, "server.log")
def log(msg):
    try: open(LOGF, "a", encoding="utf-8").write(time.strftime("%m-%d %H:%M:%S ") + msg + "\n")
    except Exception: pass

class Server(ThreadingHTTPServer):
    # Windows에서 SO_REUSEADDR를 켜면 같은 포트에 서버가 두 개 붙을 수 있어요(옛 프로세스가 연결을 가로챔) → 끄고, 대신 독점 사용
    allow_reuse_address = os.name != "nt"
    daemon_threads = True
    def server_bind(self):
        if os.name == "nt":
            import socket
            try: self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            except Exception: pass
        super().server_bind()

def serve():
    global SERVER
    for i in range(40):   # 다시 켤 때 이전 프로세스가 포트를 놓을 때까지 기다림
        try: SERVER = Server(("127.0.0.1", PORT), H); break
        except OSError: time.sleep(0.25)
    else: raise SystemExit("포트 %d을 쓸 수 없어요. 편집기가 이미 켜져 있는지 확인하세요." % PORT)
    return SERVER

def supervise():
    """START.bat이 켜는 바깥 프로세스: 실제 서버(--child)를 띄우고, 업데이트로 코드 3을 내며 끝나면 새 코드로 다시 띄워요(11-06 업데이트 뒤 꺼지던 문제)."""
    first = True
    while True:
        args = [sys.executable, os.path.join(ROOT, "server.py"), "--child"] + ([] if first and "--no-browser" not in sys.argv else ["--no-browser"])
        rc = subprocess.call(args, cwd=ROOT); first = False
        if rc == 3: print("[업데이트] 새 버전으로 다시 켜요…", flush=True); log("restart after update"); time.sleep(0.3); continue
        if rc not in (0, None):
            log(f"child exited {rc}"); print(f"[!] 편집기가 멈췄어요(코드 {rc}). 3초 뒤 다시 켜요. 계속 반복되면 {LOGF} 를 보내 주세요.", flush=True)
            time.sleep(3); continue
        break

if __name__ == "__main__" and "--child" not in sys.argv:
    try: supervise()
    except KeyboardInterrupt: pass
    raise SystemExit(0)

if __name__ == "__main__":
    import traceback
    try:
        for m in DB.values():   # 끊겼던 작업 다시
            if m.get("status") == "working": queue_assets(m["id"])
        s = serve(); log(f"child start {local_version()} pid {os.getpid()}")
        url = f"http://127.0.0.1:{PORT}"; print("숨결 편집기:", url, local_version(), f"(pid {os.getpid()}, 이 창을 닫으면 꺼져요)", flush=True)
        if "--no-browser" not in sys.argv: threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        try: s.serve_forever()
        except KeyboardInterrupt: pass
        if RESTART: s.server_close(); raise SystemExit(3)
    except SystemExit: raise
    except Exception:
        log(traceback.format_exc()); traceback.print_exc(); raise SystemExit(1)
