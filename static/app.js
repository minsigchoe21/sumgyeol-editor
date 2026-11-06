// 숨결 편집기 M1 — 화면 쪽. 프로젝트 = {name,w,h,fps,clips:[...]} / 클립 = {id,track,kind,media?,start,in,dur,...}
const $ = (s) => document.querySelector(s);
const api = async (url, body) => {
  const r = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
};
const TRACKS = [{ id: "T1", label: "글자", kinds: ["text"] }, { id: "V1", label: "영상", kinds: ["video", "image"] }, { id: "A1", label: "소리", kinds: ["audio"] }];
const LANE_X = 60;
let MEDIA = {};                 // id -> media
let P = newProject();           // 지금 프로젝트
let sel = null;                 // 고른 클립 id
let pps = 60;                   // 1초당 픽셀
let t = 0, playing = false, wall0 = 0, t0 = 0;
const undoS = [], redoS = [];

function newProject(name = "새 프로젝트", w = 1080, h = 1920) { return { name, w, h, fps: 30, clips: [], v: 1 }; }
const uid = () => Math.random().toString(36).slice(2, 9);
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(2).padStart(5, "0")}`; };
const projDur = () => P.clips.reduce((a, c) => Math.max(a, c.start + c.dur), 0);
const clipById = (id) => P.clips.find((c) => c.id === id);

// ------------------------------------------------------------ 되돌리기 ----
function snap() { undoS.push(JSON.stringify(P)); if (undoS.length > 200) undoS.shift(); redoS.length = 0; dirty(); }
function undo() { if (!undoS.length) return; redoS.push(JSON.stringify(P)); P = JSON.parse(undoS.pop()); afterLoad(); }
function redo() { if (!redoS.length) return; undoS.push(JSON.stringify(P)); P = JSON.parse(redoS.pop()); afterLoad(); }
let saveTimer = null;
function dirty() { isDirty = true; $("#saveState").textContent = "저장 안 됨"; clearTimeout(saveTimer); saveTimer = setTimeout(save, 4000); }
let isDirty = false;
async function save() {
  P.name = $("#projName").value.trim() || "새 프로젝트";
  const r = await api("/api/project", P); if (r.ok) { isDirty = false; try { localStorage.setItem("lastProj", P.name); } catch (e) {} } $("#saveState").textContent = r.ok ? "저장됨 " + new Date().toLocaleTimeString() : "저장 실패";
}

// ------------------------------------------------------------ 미디어 ----
async function loadMedia() {
  const list = await api("/api/media"); MEDIA = {}; list.forEach((m) => (MEDIA[m.id] = m));
  const box = $("#mediaList"); box.innerHTML = "";
  list.slice().reverse().forEach((m) => {
    const d = document.createElement("div"); d.className = "mi " + (m.status || ""); d.draggable = m.status === "ready"; d.title = m.path + (m.credit ? `\n출처: ${m.credit.source} ${m.credit.author} (${m.credit.license})` : "");
    const img = m.kind === "audio" ? (m.status === "ready" ? `/media/${m.id}/wave.png` : "") : (m.status === "ready" ? `/media/${m.id}/thumb.jpg` : "");
    d.innerHTML = `<img src="${img}" alt=""><div class="badge">${{ video: "영상", audio: "소리", image: "그림" }[m.kind]} ${m.kind !== "image" ? m.dur.toFixed(1) + "초" : ""}</div><div class="nm">${m.status === "working" ? "준비 중… " : m.status === "error" ? "오류 " : ""}${m.name}</div>`;
    d.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/media", m.id); });
    d.addEventListener("dblclick", () => addMediaClip(m.id, null));
    box.appendChild(d);
  });
  if (list.some((m) => m.status === "working")) setTimeout(loadMedia, 1500);
}
$("#btnPick").onclick = async () => { $("#btnPick").textContent = "PC에서 파일을 고르세요…"; await api("/api/pick", {}); $("#btnPick").textContent = "＋ 파일 가져오기"; loadMedia(); };

function trackFor(kind) { return TRACKS.find((tr) => tr.kinds.includes(kind)).id; }
function addMediaClip(mid, at, trackId) {
  const m = MEDIA[mid]; if (!m || m.status !== "ready") return;
  const tr = trackId && TRACKS.find((x) => x.id === trackId).kinds.includes(m.kind) ? trackId : trackFor(m.kind);
  const start = at ?? P.clips.filter((c) => c.track === tr).reduce((a, c) => Math.max(a, c.start + c.dur), 0);
  snap();
  const c = { id: uid(), track: tr, kind: m.kind, media: mid, src: m.rel || m.path, start: Math.max(0, start), in: 0, dur: m.kind === "image" ? 5 : m.dur, vol: 1, fit: "cover", zoom: 1, x: 0.5, y: 0.5, speed: 1 };
  P.clips.push(c); sel = c.id; renderTL(); renderInsp(); draw();
}

// ------------------------------------------------------------ 타임라인 ----
function renderTL() {
  const dur = Math.max(projDur() + 10, 60), W = dur * pps;
  const ruler = $("#ruler"); ruler.style.width = W + "px"; ruler.innerHTML = "";
  const step = pps >= 120 ? 1 : pps >= 40 ? 2 : pps >= 20 ? 5 : 10;
  for (let s = 0; s <= dur; s += step) { const k = document.createElement("div"); k.className = "tick"; k.style.left = s * pps + "px"; k.textContent = fmt(s).slice(0, 5); ruler.appendChild(k); }
  const tracks = $("#tracks"); tracks.innerHTML = ""; tracks.style.width = W + LANE_X + "px";
  for (const tr of TRACKS) {
    const row = document.createElement("div"); row.className = "track"; row.dataset.track = tr.id;
    row.innerHTML = `<div class="lab">${tr.label}</div><div class="lane"></div>`;
    const lane = row.querySelector(".lane");
    lane.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("drop"); });
    lane.addEventListener("dragleave", () => row.classList.remove("drop"));
    lane.addEventListener("drop", (e) => {
      e.preventDefault(); row.classList.remove("drop"); const mid = e.dataTransfer.getData("text/media"); if (!mid) return;
      const x = e.clientX - lane.getBoundingClientRect().left; addMediaClip(mid, snapTime(x / pps, null, tr.id), tr.id);
    });
    lane.addEventListener("mousedown", (e) => { if (e.target === lane) { sel = null; seek((e.clientX - lane.getBoundingClientRect().left) / pps); renderTL(); renderInsp(); } });
    for (const c of P.clips.filter((c) => c.track === tr.id)) lane.appendChild(clipEl(c));
    tracks.appendChild(row);
  }
  $("#tdur").textContent = fmt(projDur()); placeHead();
}
function clipEl(c) {
  const d = document.createElement("div"); d.className = `clip ${c.kind}${c.id === sel ? " sel" : ""}`;
  d.style.left = c.start * pps + "px"; if (c.kind === "text") d.title = c.text || ""; d.style.width = Math.max(4, c.dur * pps) + "px";
  const m = MEDIA[c.media];
  if (c.kind === "video" && m) { d.style.backgroundImage = `url(/media/${c.media}/strip.jpg)`; }
  if (c.kind === "audio" && m) { d.style.backgroundImage = `url(/media/${c.media}/wave.png)`; d.style.backgroundSize = `${(m.dur / (c.speed || 1)) * pps}px 100%`; d.style.backgroundPosition = `${-c.in / (c.speed || 1) * pps}px 0`; }
  d.innerHTML = `<div class="cn"${c.kind === "text" ? ' style="white-space:normal;font-size:11px;line-height:1.25"' : ""}>${c.kind === "text" ? (c.n ? c.n + ". " : "T ") + (c.text || "").replace(/\n/g, " / ") : (m ? m.name : "?")}</div><div class="h l"></div><div class="h r"></div>${c.fadeIn ? `<div class="fade in" style="width:${c.fadeIn * pps}px"></div>` : ""}${c.fadeOut ? `<div class="fade out" style="width:${c.fadeOut * pps}px"></div>` : ""}`;
  d.addEventListener("mousedown", (e) => startDrag(e, c, e.target.classList.contains("l") ? "l" : e.target.classList.contains("r") ? "r" : "m"));
  return d;
}
function edges(exceptId) { const a = [0, t]; for (const c of P.clips) if (c.id !== exceptId) a.push(c.start, c.start + c.dur); return a; }
function snapTime(s, exceptId) { const th = 8 / pps; let best = s, bd = th; for (const e of edges(exceptId)) { const d = Math.abs(e - s); if (d < bd) { bd = d; best = e; } } return Math.max(0, best); }
function startDrag(e, c, mode) {
  e.stopPropagation(); e.preventDefault(); sel = c.id; renderInsp();
  const x0 = e.clientX, o = { start: c.start, in: c.in, dur: c.dur }, before = JSON.stringify(P); let moved = false;
  const m = MEDIA[c.media], maxDur = (src) => (c.kind === "video" || c.kind === "audio") && m ? (m.dur - src) / (c.speed || 1) : 1e9;
  const mv = (ev) => {
    const ds = (ev.clientX - x0) / pps; if (Math.abs(ev.clientX - x0) > 2) moved = true;
    if (mode === "m") { let s = o.start + ds; const s1 = snapTime(s, c.id), s2 = snapTime(s + c.dur, c.id) - c.dur; c.start = Math.max(0, Math.abs(s1 - s) <= Math.abs(s2 - s) ? s1 : s2); }
    else if (mode === "r") { const end = snapTime(o.start + o.dur + ds, c.id); c.dur = Math.min(Math.max(0.1, end - c.start), maxDur(c.in)); }
    else { let ns = snapTime(o.start + ds, c.id); ns = Math.min(ns, o.start + o.dur - 0.1); let din = (ns - o.start) * (c.speed || 1); if (c.kind !== "text" && c.kind !== "image") { if (o.in + din < 0) { din = -o.in; ns = o.start + din / (c.speed || 1); } } c.start = Math.max(0, ns); c.in = Math.max(0, o.in + din); c.dur = o.dur - (c.start - o.start); }
    renderTL(); draw();
  };
  const up = () => { removeEventListener("mousemove", mv); removeEventListener("mouseup", up); if (moved) { undoS.push(before); redoS.length = 0; dirty(); } renderTL(); renderInsp(); };
  addEventListener("mousemove", mv); addEventListener("mouseup", up); renderTL();
}
$("#ruler").addEventListener("mousedown", (e) => {
  const r = $("#ruler").getBoundingClientRect(); const f = (ev) => seek((ev.clientX - r.left) / pps); f(e);
  const up = () => { removeEventListener("mousemove", f); removeEventListener("mouseup", up); }; addEventListener("mousemove", f); addEventListener("mouseup", up);
});
$("#zoom").oninput = (e) => { pps = +e.target.value; renderTL(); };
function placeHead() { $("#playhead").style.left = t * pps + "px"; $("#tc").textContent = fmt(t); }

// ------------------------------------------------------------ 편집 동작 ----
function splitAt() {
  const c = clipById(sel) || P.clips.find((c) => c.track !== "A1" && t > c.start && t < c.start + c.dur); if (!c || !(t > c.start + 0.05 && t < c.start + c.dur - 0.05)) return;
  snap(); const k = t - c.start, n = { ...c, id: uid(), start: t, in: c.in + k * (c.speed || 1), dur: c.dur - k }; c.dur = k; P.clips.push(n); sel = n.id; renderTL(); renderInsp();
}
function prevOf(c) { return P.clips.filter((x) => x.track === c.track && x.id !== c.id && x.start < c.start).sort((a, b) => b.start - a.start)[0]; }
function crossfade(c, d) {   // 앞 클립 끝과 d초 겹치게: 가능하면 원본 앞부분을 더 써서(자막 위치 그대로), 안 되면 클립을 d초 앞당겨요
  const p = prevOf(c); if (!p) { c.fadeIn = d; return; }
  const gap = c.start - (p.start + p.dur); const need = d + Math.max(0, gap);
  const canPre = c.kind === "video" ? c.in / (c.speed || 1) : c.kind === "image" ? 1e9 : 0;
  if (canPre >= need) { c.start -= need; c.dur += need; if (c.kind === "video") c.in -= need * (c.speed || 1); }
  else { c.start = p.start + p.dur - d; }
  c.fadeIn = d;
}
function crossfadeAll() { snap(); const v = P.clips.filter((c) => c.track === "V1").sort((a, b) => a.start - b.start); v.slice(1).forEach((c) => crossfade(c, 0.5)); if (v[0]) v[0].fadeIn = 0.4; if (v.length) v[v.length - 1].fadeOut = 0.6; renderTL(); renderInsp(); draw(); }
function delSel() { if (!sel) return; snap(); P.clips = P.clips.filter((c) => c.id !== sel); sel = null; renderTL(); renderInsp(); draw(); }
function addText() { snap(); const c = { id: uid(), track: "T1", kind: "text", start: t, in: 0, dur: 3, text: "글자를 입력하세요", size: 64, color: "#ffffff", y: 0.68, stroke: 8 }; P.clips.push(c); sel = c.id; renderTL(); renderInsp(); draw(); }
$("#btnXfAll").onclick = crossfadeAll; $("#btnSplit").onclick = splitAt; $("#btnDel").onclick = delSel; $("#btnText").onclick = addText; $("#btnUndo").onclick = undo; $("#btnRedo").onclick = redo;

// ------------------------------------------------------------ 속성 ----
function renderInsp() {
  const c = clipById(sel), box = $("#insp");
  if (!c) { box.className = "dim"; box.innerHTML = "클립을 고르면 여기서 고쳐요."; return; }
  box.className = "";
  const f = (k, label, type = "number", step = 0.01, extra = "") => `<label>${label}<input data-k="${k}" type="${type}" step="${step}" value="${typeof c[k] === "number" ? +c[k].toFixed(3) : (c[k] ?? "")}" ${extra}></label>`;
  let h = `<div class="dim" style="font-size:12px">${c.kind === "text" ? "글자" : (MEDIA[c.media]?.name || "")}</div>`;
  h += f("start", "시작(초)") + f("dur", "길이(초)");
  if (c.kind === "video" || c.kind === "audio") h += f("in", "원본에서 시작(초)") + f("speed", "속도(1 = 보통)", "number", 0.05, 'min="0.1" max="4"') + f("vol", "음량(0~2)", "number", 0.05, 'min="0" max="2"');
  if (c.kind === "video" || c.kind === "image") h += `<label>맞춤<select data-k="fit"><option value="cover"${c.fit === "cover" ? " selected" : ""}>꽉 채우기</option><option value="contain"${c.fit === "contain" ? " selected" : ""}>전체 보이기</option></select></label>` + f("zoom", "확대", "range", 0.01, 'min="1" max="3"') + f("x", "가로 위치", "range", 0.01, 'min="0" max="1"') + f("y", "세로 위치", "range", 0.01, 'min="0" max="1"');
  if (c.kind === "text") h += `<label>글자<textarea data-k="text">${c.text || ""}</textarea></label>` + f("size", "크기", "number", 1) + f("color", "색", "color", 1) + f("y", "세로 위치", "range", 0.01, 'min="0" max="1"') + f("stroke", "외곽선 두께", "number", 1);
  h += `<div class="row" style="gap:6px">${f("fadeIn", "서서히 나타나기(초)", "number", 0.1, 'min="0" max="5"')}${f("fadeOut", "서서히 사라지기(초)", "number", 0.1, 'min="0" max="5"')}</div>`;
  if (c.track === "V1") h += `<div class="row"><button id="btnXf">앞 영상과 겹쳐 바뀌기(0.5초)</button></div>`;
  if (MEDIA[c.media]?.credit) { const cr = MEDIA[c.media].credit; h += `<p class="dim" style="font-size:11px">출처: ${cr.source} · ${cr.author} · ${cr.license}<br><a href="${cr.page}" target="_blank" style="color:#7fd0ff">${cr.page}</a></p>`; }
  box.innerHTML = h;
  const bx = $("#btnXf"); if (bx) bx.onclick = () => { snap(); crossfade(c, 0.5); renderTL(); renderInsp(); draw(); };
  box.querySelectorAll("[data-k]").forEach((el) => {
    el.addEventListener("focus", () => (el._b = JSON.stringify(P)));
    el.addEventListener("input", () => {
      const k = el.dataset.k; let v = el.type === "number" || el.type === "range" ? parseFloat(el.value) : el.value;
      if (Number.isNaN(v)) return;
      if (k === "speed") { const old = c.speed || 1; v = Math.min(4, Math.max(0.1, v)); c.dur = c.dur * old / v; }
      c[k] = v; renderTL(); draw();
    });
    el.addEventListener("change", () => { if (el._b && el._b !== JSON.stringify(P)) { undoS.push(el._b); redoS.length = 0; dirty(); } el._b = JSON.stringify(P); });
  });
}

// ------------------------------------------------------------ 재생·그리기 ----
const cv = $("#cv"), g = cv.getContext("2d");
const EL = {};   // media id -> <video>/<audio>/<img>
function elFor(m) {
  if (EL[m.id]) return EL[m.id];
  let e;
  if (m.kind === "video") { e = document.createElement("video"); e.src = `/media/${m.id}/proxy.mp4`; e.preload = "auto"; e.playsInline = true; }
  else if (m.kind === "audio") { e = document.createElement("audio"); e.src = `/media/${m.id}/proxy.m4a`; e.preload = "auto"; }
  else { e = new Image(); e.src = `/media/${m.id}/proxy.jpg`; e.onload = () => draw(); }
  if (m.kind !== "image") e.addEventListener("seeked", () => { if (!playing) draw(); });
  EL[m.id] = e; return e;
}
// 서서히 나타나기/사라지기(11-06 "영상이 서서히 사라지고 서서히 생기고"). 같은 트랙에서 겹친 뒤 클립의 fadeIn = 크로스페이드
function fadeA(c, tt) {
  let a = 1; const fi = c.fadeIn || 0, fo = c.fadeOut || 0;
  if (fi > 0) a = Math.min(a, (tt - c.start) / fi); if (fo > 0) a = Math.min(a, (c.start + c.dur - tt) / fo);
  return Math.max(0, Math.min(1, a));
}
const active = (tt) => P.clips.filter((c) => tt >= c.start && tt < c.start + c.dur);
function drawMedia(c, e) {
  const iw = e.videoWidth || e.naturalWidth, ih = e.videoHeight || e.naturalHeight; if (!iw) return;
  const s = (c.fit === "contain" ? Math.min(P.w / iw, P.h / ih) : Math.max(P.w / iw, P.h / ih)) * (c.zoom || 1);
  const w = iw * s, h = ih * s; const x = (P.w - w) * (c.x ?? 0.5), y = (P.h - h) * (c.y ?? 0.5);
  g.drawImage(e, x, y, w, h);
}
function drawText(c) {
  const sz = c.size || 64, lh = sz * 1.25, maxW = P.w * 0.86;
  g.font = `900 ${sz}px "Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif`; g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
  const lines = [];   // 화면 폭에 맞춰 자동 줄바꿈
  for (const para of (c.text || "").split("\n")) { let cur = ""; for (const w of para.split(" ")) { const tryL = cur ? cur + " " + w : w; if (g.measureText(tryL).width > maxW && cur) { lines.push(cur); cur = w; } else cur = tryL; } lines.push(cur); }
  let y = P.h * (c.y ?? 0.68) - (lines.length - 1) * lh / 2;
  for (const l of lines) { g.lineWidth = (c.stroke ?? 8) * 2; g.strokeStyle = "#000"; if (g.lineWidth > 0) g.strokeText(l, P.w / 2, y); g.fillStyle = c.color || "#fff"; g.fillText(l, P.w / 2, y); y += lh; }
}
function draw() {
  g.fillStyle = "#000"; g.fillRect(0, 0, P.w, P.h);
  const act = active(t);
  for (const c of act.filter((c) => c.track === "V1").sort((a, b) => a.start - b.start)) { const m = MEDIA[c.media]; if (m) { g.globalAlpha = fadeA(c, t); drawMedia(c, elFor(m)); } }
  for (const c of act.filter((c) => c.kind === "text")) { g.globalAlpha = fadeA(c, t); drawText(c); }
  g.globalAlpha = 1;
}
function sync(hard) {
  const act = active(t), used = new Set();
  for (const c of act) {
    if (c.kind !== "video" && c.kind !== "audio") continue; const m = MEDIA[c.media]; if (!m) continue; const e = elFor(m); used.add(m.id);
    const want = c.in + (t - c.start) * (c.speed || 1); e.playbackRate = c.speed || 1; e.volume = Math.min(1, Math.max(0, (c.vol ?? 1) * fadeA(c, t))); e.muted = (c.vol ?? 1) === 0;
    if (playing) { if (e.paused) { e.currentTime = want; e.play().catch(() => {}); } else if (Math.abs(e.currentTime - want) > 0.25) e.currentTime = want; }
    else if (hard || Math.abs(e.currentTime - want) > 0.03) { e.pause(); e.currentTime = want; }
  }
  for (const id in EL) if (!used.has(id) && EL[id].pause) EL[id].pause();
}
function seek(s) { t = Math.max(0, s); if (playing) { t0 = t; wall0 = performance.now(); } placeHead(); sync(true); draw(); }
function loop() {
  if (playing) {
    t = t0 + (performance.now() - wall0) / 1000;
    if (t >= projDur()) { t = projDur(); togglePlay(false); }
    placeHead(); sync(false); draw();
    const vis = $("#tlBody"), x = t * pps; if (x > vis.scrollLeft + vis.clientWidth - 80) vis.scrollLeft = x - 120;
  }
  requestAnimationFrame(loop);
}
function togglePlay(on = !playing) {
  playing = on; $("#btnPlay").textContent = playing ? "❚❚" : "▶";
  if (playing) { if (t >= projDur() - 0.01) t = 0; t0 = t; wall0 = performance.now(); sync(true); } else { for (const id in EL) EL[id].pause && EL[id].pause(); }
}
$("#btnPlay").onclick = () => togglePlay();
requestAnimationFrame(loop);

// ------------------------------------------------------------ 키보드 ----
addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (e.key === "s" || e.key === "S") splitAt();
  else if (e.key === "t" || e.key === "T") addText();
  else if (e.key === "Delete" || e.key === "Backspace") delSel();
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
  else if (e.key === "ArrowLeft") seek(t - (e.shiftKey ? 1 : 1 / P.fps));
  else if (e.key === "ArrowRight") seek(t + (e.shiftKey ? 1 : 1 / P.fps));
  else if (e.key === "Home") seek(0);
});

// ------------------------------------------------------------ 프로젝트 ----
async function relink() {   // 다른 PC에서 저장한 프로젝트면 src로 미디어 다시 연결
  const miss = [...new Set(P.clips.filter((c) => c.media && !MEDIA[c.media] && c.src).map((c) => c.src))]; if (!miss.length) return;
  const map = await api("/api/resolve", { srcs: miss }); await loadMedia();
  P.clips.forEach((c) => { if (c.media && !MEDIA[c.media] && map[c.src]) c.media = map[c.src]; });
  const bad = P.clips.filter((c) => c.media && !MEDIA[c.media]).length; if (bad) alert(`원본을 못 찾은 클립 ${bad}개 — 01_쇼츠\\sources 에 원본이 있는지 확인하세요.`);
  renderTL(); draw();
}
function afterLoad() {
  $("#projName").value = P.name; $("#aspect").value = `${P.w}x${P.h}`; cv.width = P.w; cv.height = P.h;
  if (sel && !clipById(sel)) sel = null; renderTL(); renderInsp(); seek(Math.min(t, projDur()));
}
$("#aspect").onchange = (e) => { snap(); const [w, h] = e.target.value.split("x").map(Number); P.w = w; P.h = h; afterLoad(); };
$("#projName").onchange = dirty;
$("#btnSave").onclick = save;
$("#btnNew").onclick = () => { if (P.clips.length && !confirmBox()) return; P = newProject(); undoS.length = redoS.length = 0; afterLoad(); };
function confirmBox() { return window.confirm("지금 프로젝트는 저장됐나요? 새로 시작할까요?"); }
$("#btnOpen").onclick = async () => {
  const names = await api("/api/projects");
  modal(`<h3>프로젝트 열기</h3><div class="plist">${names.map((n) => `<button data-n="${n}">${n}</button>`).join("") || '<p class="dim">저장된 프로젝트가 없어요.</p>'}</div>`);
  $("#modalBody").querySelectorAll("[data-n]").forEach((b) => (b.onclick = async () => { P = await api("/api/project?name=" + encodeURIComponent(b.dataset.n)); undoS.length = redoS.length = 0; closeModal(); afterLoad(); relink(); }));
};
function modal(html) { $("#modalBody").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }
$("#modalClose").onclick = closeModal;

// ------------------------------------------------------------ 탭: 대본 추천 · 영상 찾기 ----
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x.id === "tab-" + b.dataset.tab));
}));
let SCRIPT = null;
$("#btnRec").onclick = async () => {
  $("#recOut").innerHTML = '<p class="dim">대본을 만드는 중이에요(30초~1분)…</p>';
  const r = await api("/api/recommend", { channel: $("#chSel").value, topic: $("#topic").value, n: +$("#nSent").value });
  if (r.error) { $("#recOut").innerHTML = `<p style="color:#ff8a65">${r.error}</p>`; return; }
  SCRIPT = r; showScript();
};
function showScript() {
  const r = SCRIPT; let h = "";
  if (r.ideas) h += `<p class="dim">주제 후보</p>` + r.ideas.map((i) => `<div class="sent"><b>${i.title}</b><div class="en">${i.hook || ""}</div><div class="en">${i.why || ""}</div><button data-topic="${encodeURIComponent(i.title)}">이 주제로 다시</button></div>`).join("");
  if (r.script) {
    h += `<p><b>${r.script.title}</b> <button id="btnAuto">문장마다 영상 자동으로 가져오기</button> <button id="btnSubs">자막으로 넣기</button></p>`;
    h += r.script.sentences.map((s, i) => `<div class="sent"><div class="ko">${i + 1}. ${s.ko}</div><div class="en">${s.en || ""}</div><div class="en">근거: ${s.fact_source || "?"}</div><div class="kw">${(s.search || []).map((k) => `<button data-q="${encodeURIComponent(k)}">🔎 ${k}</button>`).join("")}</div></div>`).join("");
  }
  $("#recOut").innerHTML = h;
  $("#recOut").querySelectorAll("[data-topic]").forEach((b) => (b.onclick = () => { $("#topic").value = decodeURIComponent(b.dataset.topic); $("#btnRec").click(); }));
  $("#recOut").querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => { $("#q").value = decodeURIComponent(b.dataset.q); document.querySelector('[data-tab="find"]').click(); $("#btnFind").click(); }));
  const ba = $("#btnAuto"); if (ba) ba.onclick = autoFetch;
  const bs = $("#btnSubs"); if (bs) bs.onclick = scriptToSubs;
}
async function autoFetch() {
  // 문장마다 첫 검색어로 찾아 맞는 방향의 첫 영상을 받아 순서대로 V1에 놓아요(문장 하나 = 약 6초 자리)
  const ss = SCRIPT.script.sentences, orient = P.h > P.w ? "portrait" : "landscape";
  for (let i = 0; i < ss.length; i++) {
    $("#btnAuto").textContent = `가져오는 중 ${i + 1}/${ss.length}…`;
    const q = (ss[i].search || [])[0]; if (!q) continue;
    let r = await api("/api/search", { q, source: $("#src").value, orient }); if (r.error) { alert(r.error); break; }
    if (!r.items?.length) r = await api("/api/search", { q, source: $("#src").value, orient: "" });
    const it = r.items?.[0]; if (!it) continue;
    const f = await api("/api/fetch", it); if (f.error) continue;
    await waitReady(f.ids[0]); addMediaClip(f.ids[0], null, "V1"); const c = clipById(sel); if (c) c.dur = Math.min(c.dur, 6);
  }
  $("#btnAuto").textContent = "다 가져왔어요"; renderTL();
}
async function waitReady(id) { for (let k = 0; k < 600; k++) { await loadMedia(); if (MEDIA[id]?.status !== "working") return; await new Promise((r) => setTimeout(r, 1000)); } }
function scriptToSubs() {
  snap(); let s = 0;
  for (const x of SCRIPT.script.sentences) { const d = Math.max(2.5, (x.ko || "").replace(/\s/g, "").length / 6.3); P.clips.push({ id: uid(), track: "T1", kind: "text", start: s, in: 0, dur: d, text: x.en || x.ko, size: 58, color: "#ffffff", y: 0.68, stroke: 8 }); s += d; }
  renderTL(); draw();
}
$("#btnFind").onclick = async () => {
  $("#findOut").innerHTML = '<p class="dim">찾는 중…</p>';
  const r = await api("/api/search", { q: $("#q").value, source: $("#src").value, orient: $("#orient").value });
  if (r.error) { $("#findOut").innerHTML = `<p style="color:#ff8a65">${r.error}</p>`; return; }
  $("#findOut").innerHTML = r.items.map((it, i) => `<div class="fi"><img src="${it.thumb}" alt=""><div class="meta">${it.w}×${it.h} · ${it.dur}초<br>${it.author}</div><button data-i="${i}">받아서 넣기</button></div>`).join("") || '<p class="dim">없어요.</p>';
  $("#findOut").querySelectorAll("[data-i]").forEach((b) => (b.onclick = async () => {
    b.textContent = "받는 중…"; b.disabled = true; const f = await api("/api/fetch", r.items[+b.dataset.i]);
    b.textContent = f.error ? "실패" : "받음 ✓"; loadMedia(); document.querySelector('[data-tab="media"]').click();
  }));
};
async function initTop() {
  try { const v = await api("/api/version"); document.querySelector(".logo").title = "버전 " + v.version; document.querySelector(".logo").textContent = "숨결 편집기 " + v.version.slice(4); } catch (e) {}
  const chs = await api("/api/channels"); $("#chSel").innerHTML = chs.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");
  const k = await api("/api/keys"); $("#keyState").textContent = `키: Claude ${k.anthropic ? "✓" : "✕"} · Pexels ${k.pexels ? "✓" : "✕"} · Pixabay ${k.pixabay ? "✓" : "✕"}`; $("#keyState").title = `키 파일: ${k.file}\n프로젝트: ${k.projects}\n소스: ${k.sources}`; if (!k.shorts) $("#keyState").textContent += " · ⚠ 01_쇼츠 밖에서 실행 중";
}

// ------------------------------------------------------------ 자막(.srt) → 글자 트랙 (11-06 "소리를 듣지 않고 자막으로 제어") ----
function parseSrt(txt) {
  const ts = (x) => { const m = x.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : 0; };
  return txt.replace(/\r/g, "").split(/\n\s*\n/).map((b) => b.trim().split("\n")).filter((l) => l.length >= 2).map((l) => {
    const k = l.findIndex((x) => x.includes("-->")); if (k < 0) return null; const [a, b] = l[k].split("-->");
    return { a: ts(a), b: ts(b), text: l.slice(k + 1).join("\n") };
  }).filter(Boolean);
}
$("#btnSrt").onclick = () => $("#srtFile").click();
$("#srtFile").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return; const subs = parseSrt(await f.text()); if (!subs.length) { alert("자막을 못 읽었어요(.srt 형식인지 확인)"); return; }
  snap(); P.clips = P.clips.filter((c) => !(c.kind === "text" && c.fromSrt));
  subs.forEach((s, i) => P.clips.push({ id: uid(), track: "T1", kind: "text", fromSrt: true, start: s.a, in: 0, dur: Math.max(0.2, s.b - s.a), text: s.text, size: 52, color: "#ffffff", y: 0.7, stroke: 7, n: i + 1 }));
  e.target.value = ""; renderTL(); draw();
};

// ------------------------------------------------------------ 시작 ----
window.ed = { get P() { return P; }, set P(v) { P = v; afterLoad(); }, addMediaClip, seek, togglePlay, MEDIA: () => MEDIA, loadMedia };
// ------------------------------------------------------------ 켜 둔 채로 자동 업데이트 ----
// 3분마다 GitHub 새 버전 확인 → 재생 중이 아니면 저장하고 적용 → 서버가 다시 켜지면 같은 프로젝트로 새로고침
async function checkUpdate() {
  try {
    const r = await api("/api/update/check"); if (!r.update || playing) return;
    if (P.clips.length) await save();
    const ov = document.createElement("div"); ov.id = "updOv"; ov.textContent = `새 버전(${r.remote.slice(4)})으로 바꾸는 중… 잠깐만요`; document.body.appendChild(ov);
    const a = await api("/api/update/apply", {}); if (a.error) { ov.textContent = a.error; setTimeout(() => ov.remove(), 4000); return; }
    for (let i = 0; i < 60; i++) { await new Promise((res) => setTimeout(res, 1000)); try { const v = await api("/api/version"); if (v.version === r.remote) { location.reload(); return; } } catch (e) {} }
    ov.textContent = "다시 켜지지 않았어요. START.bat을 다시 실행해 주세요.";
  } catch (e) {}
}
setInterval(checkUpdate, 180000);   // 3분마다(GitHub API 한도: 시간당 60번)
(async () => {
  await initTop(); await loadMedia();
  let last = null; try { last = localStorage.getItem("lastProj"); } catch (e) {}
  if (last) { const pj = await api("/api/project?name=" + encodeURIComponent(last)); if (pj && pj.clips) { P = pj; afterLoad(); relink(); setTimeout(checkUpdate, 3000); return; } }
  afterLoad(); setTimeout(checkUpdate, 3000);
})();
