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
    d.addEventListener("click", () => { MSEL = m.id; document.querySelectorAll(".mi").forEach((x) => x.classList.toggle("msel", x === d)); });
    d.addEventListener("dblclick", () => insertMedia(m.id, false));
    if ((m.kind === "video" || m.kind === "image") && m.status === "ready") { const cb = document.createElement("button"); cb.textContent = "✂"; cb.title = "이 원본에서 구간 떠서 문장에 넣기"; cb.style.cssText = "position:absolute;top:3px;right:30px;padding:0 5px;font-size:12px"; cb.onclick = (e) => { e.stopPropagation(); openSrcMon({ mid: m.id }); }; d.appendChild(cb); }
    if (m.kind === "video" && m.status === "ready") { const sb = document.createElement("button"); sb.textContent = "🔗"; sb.title = "이어 붙일 비슷한 영상 찾기"; sb.style.cssText = "position:absolute;top:3px;right:3px;padding:0 5px;font-size:12px"; sb.onclick = (e) => { e.stopPropagation(); findSimilar(m.id); }; d.appendChild(sb); }
    box.appendChild(d);
  });
  const wk = list.filter((m) => m.status === "working").length;
  let pv = document.getElementById("prepOv");
  if (wk) { if (!pv) { pv = document.createElement("div"); pv.id = "prepOv"; pv.style.cssText = "position:fixed;right:14px;bottom:262px;background:#262b34;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;z-index:60"; document.body.appendChild(pv); }
    pv.textContent = `편집용 사본 만드는 중: ${wk}개 남음(4K는 하나에 1~3분)`; setTimeout(loadMedia, 2000); }
  else if (pv) { pv.remove(); renderTL(); draw(); }
}
$("#btnPick").onclick = async () => { $("#btnPick").textContent = "PC에서 파일을 고르세요…"; await api("/api/pick", {}); $("#btnPick").textContent = "＋ 파일 가져오기"; loadMedia(); };

// 영상 붙이기(11-07 "영상 붙이기"): 미디어를 골라 재생선 자리에 끼워 넣기(,) / 덮어쓰기(.) — 프리미어와 같은 키
let MSEL = null;
function insertMedia(mid, overwrite) {
  const m = MEDIA[mid]; if (!m || m.status !== "ready") return; const tr = trackFor(m.kind), d = m.kind === "image" ? 5 : m.dur;
  snap();
  if (overwrite) cutRange(tr, t, t + d);
  else { const cut = P.clips.find((x) => x.track === tr && t > x.start + 0.01 && t < x.start + x.dur - 0.01); if (cut) splitAtRaw(cut, t); shiftAfter(tr, t, d, null); }
  const c = { id: uid(), track: tr, kind: m.kind, media: mid, src: m.rel || m.path, start: t, in: 0, dur: d, vol: m.kind === "audio" ? 1 : 0, fit: "cover", zoom: 1, x: 0.5, y: 0.5, speed: 1 };
  P.clips.push(c); sel = c.id; seek(t + d); renderTL(); renderInsp(); draw(); dirty(); flash(overwrite ? "덮어썼어요" : "끼워 넣었어요");
}
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
    lane.addEventListener("mousedown", (e) => { if (e.target === lane) { const tt = (e.clientX - lane.getBoundingClientRect().left) / pps;
      if (isDbl("lane" + tr.id)) { joinGapAt(tr.id, tt); return; }
      sel = null; seek(tt); renderTL(); renderInsp(); } });
    for (const c of P.clips.filter((c) => c.track === tr.id)) lane.appendChild(clipEl(c));
    tracks.appendChild(row);
  }
  $("#tdur").textContent = fmt(projDur()); placeHead();
  // 문장 탭이 열려 있으면 같이 새로 그리기(11-07 "타임라인에서 글자를 삭제하면 반영이 안 된다"). 문장 탭에서 글을 치는 중이면 건드리지 않음
  const st = document.getElementById("tab-sent");
  if (st && st.classList.contains("on") && !st.contains(document.activeElement) && typeof renderSents === "function") { clearTimeout(window._rsT); window._rsT = setTimeout(renderSents, 50); }
}
function clipEl(c) {
  const d = document.createElement("div"); d.className = `clip ${c.kind}${c.id === sel ? " sel" : ""}`;
  d.style.left = c.start * pps + "px"; if (c.kind === "text") d.title = c.text || ""; d.style.width = Math.max(4, c.dur * pps) + "px";
  const m = MEDIA[c.media];
  if (c.kind === "video" && m) { d.style.backgroundImage = `url(/media/${c.media}/strip.jpg)`; d.style.backgroundSize = `${(m.dur / (c.speed || 1)) * pps}px 100%`; d.style.backgroundPosition = `${-c.in / (c.speed || 1) * pps}px 0`; d.style.backgroundRepeat = "no-repeat"; }
  if (c.kind === "audio" && m) { d.style.backgroundImage = `url(/media/${c.media}/wave.png)`; d.style.backgroundSize = `${(m.dur / (c.speed || 1)) * pps}px 100%`; d.style.backgroundPosition = `${-c.in / (c.speed || 1) * pps}px 0`; }
  const ov = c.kind === "video" && m ? c.dur - srcLeft(c) : 0;
  d.innerHTML = (ov > 0.05 ? `<div class="over" style="width:${ov * pps}px" title="원본이 ${ov.toFixed(1)}초 모자라요 → ↔ 빈틈 메우기"></div>` : "") + `<div class="cn"${c.kind === "text" ? ' style="white-space:normal;font-size:11px;line-height:1.25"' : ""}>${c.kind === "text" ? (c.n ? c.n + ". " : "T ") + (c.text || "").replace(/\n/g, " / ") : (m ? m.name : "?")}</div><div class="h l"></div><div class="h r"></div>${c.fadeIn ? `<div class="fade in" style="width:${c.fadeIn * pps}px"></div>` : ""}${c.fadeOut ? `<div class="fade out" style="width:${c.fadeOut * pps}px"></div>` : ""}`;
  d.addEventListener("mousedown", (e) => {
    const r = d.getBoundingClientRect(), nearEnd = e.clientX > r.right - Math.max(14, r.width * 0.2);
    if (nearEnd && isDbl("end" + c.id)) { e.preventDefault(); joinAfter(c); return; }   // 끝 더블클릭 = 다음 클립과 붙이기
    startDrag(e, c, e.target.classList.contains("l") ? "l" : e.target.classList.contains("r") ? "r" : "m");
  });
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
function splitAt() {   // 재생선에서 나누기: 고른 클립, 없으면 재생선 위의 모든 트랙 클립
  const at = t, cs = clipById(sel) && at > clipById(sel).start + 0.03 && at < clipById(sel).start + clipById(sel).dur - 0.03 ? [clipById(sel)] : P.clips.filter((x) => at > x.start + 0.03 && at < x.start + x.dur - 0.03);
  if (!cs.length) return; snap(); let last = null; cs.forEach((c) => (last = splitAtRaw(c, at))); sel = last?.id || sel; renderTL(); renderInsp(); draw();
}
function splitAtOld() {
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
// ---- 잘라내기·복사·붙이기·이어 붙이기(11-06 "프리미어처럼") ----
let CLIP = null;   // 클립보드
function copySel() { const c = clipById(sel); if (c) { CLIP = JSON.parse(JSON.stringify(c)); flash("복사했어요"); } }
function cutSel() { const c = clipById(sel); if (!c) return; copySel(); rippleDel(); flash("잘라냈어요(뒤 클립을 당겼어요)"); }
function shiftAfter(track, at, d, exceptId) { P.clips.forEach((x) => { if (x.track === track && x.id !== exceptId && x.start >= at - 1e-6) x.start += d; }); }
function pasteAt(overwrite) {   // 기본: 재생선 자리에 끼워 넣고 뒤를 밀어요(이어 붙이기). Shift = 덮어쓰기
  if (!CLIP) return; snap(); const n = { ...JSON.parse(JSON.stringify(CLIP)), id: uid(), start: t };
  if (!overwrite) { const cut = P.clips.find((x) => x.track === n.track && t > x.start + 0.01 && t < x.start + x.dur - 0.01); if (cut) { sel = cut.id; splitAtRaw(cut, t); } shiftAfter(n.track, t, n.dur, null); }
  else { P.clips = P.clips.filter((x) => !(x.track === n.track && x.start >= t && x.start + x.dur <= t + n.dur)); }
  P.clips.push(n); sel = n.id; seek(t + n.dur); renderTL(); renderInsp(); draw();
}
function dupSel() { const c = clipById(sel); if (!c) return; CLIP = JSON.parse(JSON.stringify(c)); const keep = t; t = c.start + c.dur; pasteAt(false); }
function rippleDel() {   // 지우고 뒤 클립을 당겨 빈틈 없애기(Shift+Delete)
  const c = clipById(sel); if (!c) return; snap(); P.clips = P.clips.filter((x) => x.id !== c.id); shiftAfter(c.track, c.start + c.dur, -c.dur, null); sel = null; renderTL(); renderInsp(); draw();
}
function rippleTrim(which) {   // Q: 재생선 앞부분 잘라내고 당기기, W: 재생선 뒷부분 잘라내기(+당기기)
  const c = clipById(sel)?.track === "V1" && t > clipById(sel).start && t < clipById(sel).start + clipById(sel).dur ? clipById(sel) : P.clips.find((x) => x.track === "V1" && t > x.start && t < x.start + x.dur);
  if (!c) return; snap(); const k = t - c.start;
  if (which === "start") { c.in += k * (c.speed || 1); c.dur -= k; shiftAfter(c.track, c.start + 1e-3, -k, null); c.start = Math.max(0, c.start); seek(c.start); }
  else { const cut = c.dur - k; c.dur = k; shiftAfter(c.track, c.start + k + cut - 1e-3, -cut, c.id); }
  renderTL(); renderInsp(); draw();
}
// 빈틈 메우기(11-07 "중간에 비어 있는 영상 붙이는 거"): 클립 위치(자막 싱크)는 그대로 두고, 앞 클립을 늘리거나 뒤 클립을 앞당겨(원본의 앞부분 사용) 검은 틈을 채워요
function fillGap(a, b, g) {
  const avA = a ? (a.kind === "image" ? 1e9 : ((MEDIA[a.media]?.dur ?? 1e9) - a.in) / (a.speed || 1) - a.dur) : 0;
  const x = Math.max(0, Math.min(g, avA)); if (a) a.dur += x; let r = g - x;
  if (r > 0.01 && b) { const avB = b.kind === "image" ? 1e9 : b.in / (b.speed || 1); const y = Math.max(0, Math.min(r, avB)); b.start -= y; b.in -= y * (b.speed || 1); b.dur += y; r -= y; }
  if (r > 0.01 && a && a.kind === "video") { const ns = Math.max(0.5, (a.speed || 1) * a.dur / (a.dur + r)); a.speed = +ns.toFixed(3); a.dur += r; r = 0; }   // 그래도 모자라면 앞 클립을 살짝 느리게
  if (r > 0.01 && a) a.dur += r;
}
function srcLeft(c) { const m = MEDIA[c.media]; return c.kind === "video" && m ? (m.dur - c.in) / (c.speed || 1) : 1e9; }
function fixOverrun(c) {   // 클립 길이가 원본보다 길어 끝이 검게(멈춰) 보이는 것: 원본 앞부분을 더 쓰고, 그래도 모자라면 살짝 느리게
  const m = MEDIA[c.media]; if (c.kind !== "video" || !m) return false; let over = c.dur - srcLeft(c); if (over <= 0.05) return false;
  const back = Math.min(c.in, over * (c.speed || 1)); c.in -= back; over = c.dur - srcLeft(c);
  if (over > 0.05) c.speed = +Math.max(0.4, (m.dur - c.in) / c.dur).toFixed(3);
  if (c.dur > srcLeft(c) + 0.05) c.dur = srcLeft(c);   // 0.4배로도 모자라면 원본 끝까지만(남는 틈은 아래에서 메움)
  return true;
}
function fillGaps() {
  snap(); let n = 0;
  P.clips.filter((x) => x.track === "V1").forEach((c) => { if (fixOverrun(c)) n++; });
  const v = P.clips.filter((x) => x.track === "V1").sort((p, q) => p.start - q.start);
  if (v[0] && v[0].start > 0.01) { fillGap(null, v[0], v[0].start); n++; }
  for (let i = 1; i < v.length; i++) { const a = v[i - 1], b = v[i], g = b.start - (a.start + a.dur); if (g > 0.01) { fillGap(a, b, g); n++; } }
  renderTL(); draw(); dirty(); flash(n ? `빈틈 ${n}곳을 메웠어요(자막 싱크 그대로)` : "빈틈이 없어요");
}
function rippleRange(a, b) {   // [a, b] 시간을 모든 트랙에서 빼고 뒤를 당겨요(싱크 유지)
  for (const tr of ["T1", "V1", "A1"]) cutRange(tr, a, b);
  P.clips.forEach((x) => { if (x.start >= b - 1e-3) x.start -= (b - a); });
}
// 끝 더블클릭으로 붙이기(11-07 "영상 끝에 더블클릭하면 영상 붙게"). 타임라인이 클릭마다 다시 그려져서 더블클릭을 직접 셉니다
let _dbl = { k: "", t: 0 };
function isDbl(key) { const now = performance.now(), hit = _dbl.k === key && now - _dbl.t < 400; _dbl = { k: hit ? "" : key, t: now }; return hit; }
function nextOn(c) { return P.clips.filter((x) => x.track === c.track && x.id !== c.id && x.start >= c.start + c.dur - 0.02).sort((a, b) => a.start - b.start)[0]; }
function joinAfter(c) {
  const n = nextOn(c), end = c.start + c.dur;
  if (!n) { flash("뒤에 붙일 클립이 없어요"); return; }
  const g = n.start - end; if (g < 0.02) { flash("이미 붙어 있어요"); return; }
  snap();
  if (c.track === "V1") fillGap(c, n, g);   // 영상: 이 클립을 늘려 붙여요(자막 싱크 그대로)
  else rippleRange(end, n.start);           // 글자·소리: 빈 시간을 모든 트랙에서 빼고 당겨요
  renderTL(); draw(); dirty(); flash(c.track === "V1" ? "영상을 늘려 붙였어요" : "빈 시간을 빼고 붙였어요(영상·소리도 같이)");
}
function joinGapAt(track, tt) {   // 빈 곳 더블클릭: 그 빈틈을 붙여요
  const prev = P.clips.filter((x) => x.track === track && x.start + x.dur <= tt + 0.01).sort((a, b) => b.start + b.dur - (a.start + a.dur))[0];
  if (prev) { sel = prev.id; joinAfter(prev); return; }
  const n = P.clips.filter((x) => x.track === track && x.start >= tt).sort((a, b) => a.start - b.start)[0];
  if (n && n.start > 0.02) { snap(); if (track === "V1") fillGap(null, n, n.start); else rippleRange(0, n.start); renderTL(); draw(); dirty(); flash("앞 빈틈을 붙였어요"); }
}
function closeGaps() {   // 당겨 붙이기(11-07): 고른 클립의 트랙(없으면 글자 트랙)에서 빈틈을 찾아, 그 시간만큼 모든 트랙을 함께 당겨요
  const tr = clipById(sel)?.track || "T1"; const name = { T1: "글자", V1: "영상", A1: "소리" }[tr];
  const cs = P.clips.filter((x) => x.track === tr).sort((p, q) => p.start - q.start); const gaps = [];
  let end = 0; for (const x of cs) { if (x.start > end + 0.02) gaps.push([end, x.start]); end = Math.max(end, x.start + x.dur); }
  if (!gaps.length) { flash(`${name} 트랙에 빈틈이 없어요`); return; }
  snap(); gaps.reverse().forEach(([a, b]) => rippleRange(a, b));
  renderTL(); draw(); dirty(); flash(`${name} 트랙 빈틈 ${gaps.length}곳을 당겨 붙였어요(영상·소리도 같이)`);
}
function splitAtRaw(c, at) { const k = at - c.start, n = { ...c, id: uid(), start: at, in: c.in + k * (c.speed || 1), dur: c.dur - k, fadeIn: 0 }; c.dur = k; c.fadeOut = 0; P.clips.push(n); return n; }
function setSpeed(c, v) {   // 슬로모션·빠르게: 원본 구간은 그대로 두고 길이가 바뀌어요
  snap(); const old = c.speed || 1, d0 = c.dur, end0 = c.start + c.dur; c.dur = c.dur * old / v; c.speed = v; const m = MEDIA[c.media]; if (m) c.dur = Math.min(c.dur, (m.dur - c.in) / v);
  shiftAfter(c.track, end0 - 1e-3, c.dur - d0, c.id);   // 뒤 클립을 같이 밀거나 당겨요
  renderTL(); renderInsp(); draw();
}
function setZoomAnim(c, z1, z2) { snap(); c.zoom = z1; c.zoomEnd = z2; c.xEnd = c.x ?? 0.5; c.yEnd = c.y ?? 0.5; renderTL(); renderInsp(); draw(); }
function flash(msg) { const d = document.createElement("div"); d.id = "updOv"; d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 1200); }
function delSel() { if (!sel) return; snap(); P.clips = P.clips.filter((c) => c.id !== sel); sel = null; renderTL(); renderInsp(); draw(); }
function addText() { snap(); const c = { id: uid(), track: "T1", kind: "text", start: t, in: 0, dur: 3, text: "글자를 입력하세요", size: 64, color: "#ffffff", y: 0.68, stroke: 8 }; P.clips.push(c); sel = c.id; renderTL(); renderInsp(); draw(); }
$("#btnGap").onclick = closeGaps; $("#btnFill").onclick = fillGaps; $("#btnCut").onclick = cutSel; $("#btnCopy").onclick = copySel; $("#btnPaste").onclick = () => pasteAt(false);
$("#btnSrcMon").onclick = () => openSrcMon(); $("#btnXfAll").onclick = crossfadeAll; $("#btnSplit").onclick = splitAt; $("#btnDel").onclick = delSel; $("#btnText").onclick = addText; $("#btnUndo").onclick = undo; $("#btnRedo").onclick = redo;

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
  if (c.kind === "video" || c.kind === "audio") h += `<p class="dim" style="margin:10px 0 2px;font-size:12px">속도</p><div class="row" style="flex-wrap:wrap">${[0.25, 0.5, 0.75, 1, 1.5, 2, 4].map((v) => `<button data-sp="${v}" class="${(c.speed || 1) === v ? "on" : ""}" style="padding:3px 7px">${v === 1 ? "보통" : v < 1 ? "슬로 " + v + "×" : v + "× 빠르게"}</button>`).join("")}</div>`;
  if (c.kind === "video" || c.kind === "image") h += `<p class="dim" style="margin:10px 0 2px;font-size:12px">줌(클립 처음→끝)</p><div class="row" style="flex-wrap:wrap"><button data-zm="1,1.3">줌인</button><button data-zm="1.3,1">줌아웃</button><button data-zm="1,1.6">크게 줌인</button><button data-zm="off">줌 없음</button></div>` + (c.zoomEnd != null ? f("zoomEnd", "끝 확대", "range", 0.01, 'min="1" max="3"') + f("xEnd", "끝 가로 위치", "range", 0.01, 'min="0" max="1"') + f("yEnd", "끝 세로 위치", "range", 0.01, 'min="0" max="1"') : "");
  if ((c.kind === "video" || c.kind === "image") && c.media) h += `<div style="margin-top:10px;padding:8px;border:1px solid var(--acc);border-radius:8px"><b style="font-size:12px">💬 이 장면 코멘트 → Claude가 고쳐요</b>
    <textarea id="fixMemo" placeholder="예: 해달 얼굴이 잘 보이게 / 더 밝은 장면으로 / 성게가 나오는 걸로 / 너무 빨라" style="min-height:48px">${(c.memo || "").replace(/</g, "&lt;")}</textarea>
    <button id="btnFix" style="width:100%">🤖 이 코멘트대로 고쳐 줘</button><div id="fixOut" class="dim" style="font-size:12px;margin-top:4px">${c.fixReply ? "🤖 " + c.fixReply.replace(/</g, "&lt;") : ""}</div></div>`;
  if ((c.kind === "video" || c.kind === "image") && c.media) h += `<div class="row"><button id="btnRecut" style="width:100%">✂ 원본에서 구간 다시 뜨기</button></div>`;
  if (c.kind === "video" && c.media) h += `<div class="row"><button id="btnSim">🔗 이어 붙일 비슷한 영상 찾기</button></div>`;
  if (MEDIA[c.media]?.credit) { const cr = MEDIA[c.media].credit; h += `<p class="dim" style="font-size:11px">출처: ${cr.source} · ${cr.author} · ${cr.license}<br><a href="${cr.page}" target="_blank" style="color:#7fd0ff">${cr.page}</a></p>`; }
  box.innerHTML = h;
  const bs = $("#btnSim"); if (bs) bs.onclick = () => findSimilar(c.media);
  const brc = $("#btnRecut"); if (brc) brc.onclick = () => openSrcMon({ fromClip: c });
  const bf = $("#btnFix"); if (bf) { $("#fixMemo").oninput = (e) => { c.memo = e.target.value; dirty(); }; bf.onclick = () => clipFix(c); }
  box.querySelectorAll("[data-sp]").forEach((b) => (b.onclick = () => setSpeed(c, +b.dataset.sp)));
  box.querySelectorAll("[data-zm]").forEach((b) => (b.onclick = () => { if (b.dataset.zm === "off") { snap(); delete c.zoomEnd; c.zoom = 1; renderInsp(); draw(); } else { const [a, z] = b.dataset.zm.split(",").map(Number); setZoomAnim(c, a, z); } }));
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
  // 줌인·줌아웃(시작→끝 확대, 위치도 같이 움직임). 부드럽게(사인 곡선)
  const u = c.zoomEnd != null ? Math.max(0, Math.min(1, (t - c.start) / Math.max(0.01, c.dur))) : 0, ee = 0.5 - Math.cos(Math.PI * u) / 2;
  const lerp = (a, b) => a + (b - a) * ee;
  const zz = c.zoomEnd != null ? lerp(c.zoom || 1, c.zoomEnd) : (c.zoom || 1), xx = c.zoomEnd != null ? lerp(c.x ?? 0.5, c.xEnd ?? c.x ?? 0.5) : (c.x ?? 0.5), yy = c.zoomEnd != null ? lerp(c.y ?? 0.5, c.yEnd ?? c.y ?? 0.5) : (c.y ?? 0.5);
  const s = (c.fit === "contain" ? Math.min(P.w / iw, P.h / ih) : Math.max(P.w / iw, P.h / ih)) * zz;
  const w = iw * s, h = ih * s; const x = (P.w - w) * xx, y = (P.h - h) * yy;
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
  if (playing) for (const c of P.clips) {   // 곧 나올 클립은 미리 그 자리로 감아 두기(끊김 줄이기)
    if ((c.kind !== "video" && c.kind !== "audio") || c.start <= t || c.start > t + 1.2) continue; const m = MEDIA[c.media]; if (!m || used.has(m.id)) continue;
    const e = elFor(m); if (Math.abs(e.currentTime - c.in) > 0.05) e.currentTime = c.in;
  }
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
  if (playing) { if (AC && AC.state !== "running") AC.resume(); if (t >= projDur() - 0.01) t = 0; t0 = t; wall0 = performance.now(); sync(true); } else { for (const id in EL) EL[id].pause && EL[id].pause(); }
}
$("#btnPlay").onclick = () => { togglePlay(); if (playing) setTimeout(() => { const w = soundCheck(); if (w) flash("🔇 " + w); }, 600); };
async function soundDiag() {   // 🔊 소리 점검: 삐 소리 + 소리 클립 상태
  const ctx = new AudioContext(); const o = ctx.createOscillator(); const g2 = ctx.createGain(); g2.gain.value = 0.15; o.frequency.value = 660; o.connect(g2); g2.connect(ctx.destination); o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 400);
  const rows = P.clips.filter((c) => c.kind === "audio" || (c.kind === "video" && (c.vol ?? 0) > 0)).slice(0, 12).map((c) => {
    const m = MEDIA[c.media], e = m ? EL[m.id] : null;
    return `<tr><td>${c.track}</td><td>${(m?.name || c.src || "?").slice(0, 28)}</td><td>${fmt(c.start)}</td><td>${c.vol ?? 1}</td><td>${m ? m.status : "연결 안 됨"}</td><td>${e ? `rs${e.readyState} ${e.error ? "오류" + e.error.code : ""} ${e.muted ? "음소거" : ""} v${(+e.volume).toFixed(2)}` : "-"}</td></tr>`; }).join("");
  modal(`<h3>🔊 소리 점검</h3><p>방금 <b>"삐"</b> 소리가 들렸나요? 안 들렸으면 PC·브라우저 소리 문제예요(출력 장치, 탭 음소거).</p>
  <p class="dim" style="font-size:12px">오디오 처리: ${AC ? AC.state : "기본"} · 재생 위치 ${fmt(t)}</p><table style="font-size:11px;width:100%"><tr><th>트랙</th><th>파일</th><th>시작</th><th>음량</th><th>상태</th><th>재생기</th></tr>${rows || '<tr><td colspan=6>소리 클립이 없어요</td></tr>'}</table>
  <p class="dim" style="font-size:12px">이 창을 캡처해서 Claude에게 보내 주세요.</p>`);
}
function soundCheck() {   // 소리가 안 들릴 때 원인 알려 주기(11-07 "소리가 안 들려")
  const a = P.clips.filter((c) => c.kind === "audio" && t >= c.start && t < c.start + c.dur);
  if (!a.length) return "지금 위치에 소리 트랙 클립이 없어요.";
  const miss = a.filter((c) => !MEDIA[c.media]); if (miss.length) return "소리 파일이 연결되지 않았어요(" + (miss[0].src || "?") + "). 열기로 프로젝트를 다시 열어 주세요.";
  const wk = a.filter((c) => MEDIA[c.media].status !== "ready"); if (wk.length) return "소리 파일을 준비하는 중이에요. 잠시 뒤 다시 재생해 보세요.";
  const mute = a.filter((c) => (c.vol ?? 1) === 0); if (mute.length === a.length) return "소리 클립 음량이 0이에요(속성 칸 음량).";
  return "";
}
requestAnimationFrame(loop);

// ------------------------------------------------------------ 키보드 ----
addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod) {   // 프리미어와 같은 단축키
    if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === "y") { e.preventDefault(); redo(); }
    else if (k === "s") { e.preventDefault(); save(); }
    else if (k === "c") { e.preventDefault(); copySel(); }
    else if (k === "x") { e.preventDefault(); cutSel(); }
    else if (k === "v") { e.preventDefault(); pasteAt(e.shiftKey); }
    else if (k === "k") { e.preventDefault(); splitAt(); }
    else if (k === "d") { e.preventDefault(); dupSel(); }
    return;
  }
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if (k === "s" || k === "c") splitAt();
  else if (k === "t") addText();
  else if (k === "f") openSrcMon(clipById(sel)?.track === "V1" ? { fromClip: clipById(sel) } : {});
  else if (e.key === "," && MSEL) insertMedia(MSEL, false);
  else if (e.key === "." && MSEL) insertMedia(MSEL, true);
  else if (k === "q") rippleTrim("start");
  else if (k === "w") rippleTrim("end");
  else if (e.key === "Delete" || e.key === "Backspace") e.shiftKey ? rippleDel() : delSel();
  else if (e.key === "ArrowLeft") seek(t - (e.shiftKey ? 1 : 1 / P.fps));
  else if (e.key === "ArrowRight") seek(t + (e.shiftKey ? 1 : 1 / P.fps));
  else if (e.key === "ArrowUp") { const e2 = edges(null).filter((x) => x < t - 0.01).sort((a, b) => b - a)[0]; seek(e2 ?? 0); }
  else if (e.key === "ArrowDown") { const e2 = edges(null).filter((x) => x > t + 0.01).sort((a, b) => a - b)[0]; if (e2 != null) seek(e2); }
  else if (e.key === "Home") seek(0);
  else if (e.key === "End") seek(projDur());
  else if (k === "=" || k === "+") { pps = Math.min(300, pps * 1.25); $("#zoom").value = pps; renderTL(); }
  else if (k === "-") { pps = Math.max(10, pps / 1.25); $("#zoom").value = pps; renderTL(); }
});

// ------------------------------------------------------------ 프로젝트 ----
async function relink() {   // 다른 PC에서 저장한 프로젝트면 src로 미디어 다시 연결
  const miss = [...new Set(P.clips.filter((c) => c.media && !MEDIA[c.media] && c.src).map((c) => c.src))]; if (!miss.length) return;
  const need = (P.fetch || []).filter((f) => miss.includes(f.src));
  if (need.length) {   // Claude가 만든 초안: 영상·내레이션을 이 PC가 직접 받아요
    await api("/api/prefetch", { fetch: need }); const ov = document.createElement("div"); ov.id = "updOv"; document.body.appendChild(ov);
    let st = {}; for (;;) { st = await api("/api/prefetch/status", {}); ov.textContent = "초안 재료 " + (st.state || "받는 중…"); if (st.done) break; await new Promise((r) => setTimeout(r, 1500)); }
    setTimeout(() => ov.remove(), 2500);
    if (st.fail?.length) alert("못 받은 재료가 있어요:\n" + st.fail.join("\n") + "\n\n문장 탭에서 그 문장의 🎬 쓸만한 영상으로 바꿔 넣을 수 있어요.");
  }
  const map = await api("/api/resolve", { srcs: miss }); await loadMedia();
  P.clips.forEach((c) => { if (c.media && !MEDIA[c.media] && map[c.src]) c.media = map[c.src]; });
  await waitAllReady(); const bad = P.clips.filter((c) => c.media && !MEDIA[c.media]).length; if (bad) alert(`원본을 못 찾은 클립 ${bad}개 — 01_쇼츠\\sources 에 원본이 있는지 확인하세요.`);
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
const loadProj = async (n) => { P = await api("/api/project?name=" + encodeURIComponent(n)); undoS.length = redoS.length = 0; closeModal(); afterLoad(); relink(); };
$("#btnOpen").onclick = async () => {
  const names = await api("/api/projects");
  modal(`<h3>프로젝트 열기</h3><div class="plist">${names.map((n) => `<div class="row" style="margin:3px 0"><button class="grow" data-n="${n}">${n}</button><button data-h="${n}" title="저장할 때마다 남긴 이전 판">🕘 이전 판</button></div>`).join("") || '<p class="dim">저장된 프로젝트가 없어요.</p>'}</div><h3 style="margin-top:14px">Claude가 만든 초안</h3><div id="inboxL" class="plist"><p class="dim">불러오는 중…</p></div>`);
  api("/api/inbox", {}).then((r) => {
    const box = $("#inboxL"); if (!box) return;
    box.innerHTML = (r.items || []).map((x) => x.have
      ? `<div class="row" style="margin:3px 0"><button class="grow" data-n2="${x.name}">📂 ${x.name} <span class="dim">(받아 둔 것 열기 · 내 수정 그대로)</span></button><button data-re="${x.name}" title="Claude 초안으로 처음부터 다시(지금 판은 이전 판에 남아요)">↺ 다시 받기</button></div>`
      : `<button data-in="${x.name}">📥 ${x.name}</button>`).join("") || '<p class="dim">새 초안이 없어요.</p>';
    const take = async (n, ow) => { const r = await api("/api/inbox/take", { name: n, overwrite: ow }); if (r && r.exists && !ow) return loadProj(n); loadProj(n); };
    box.querySelectorAll("[data-in]").forEach((b) => (b.onclick = () => { b.textContent = "받는 중…"; take(b.dataset.in, false); }));
    box.querySelectorAll("[data-n2]").forEach((b) => (b.onclick = () => loadProj(b.dataset.n2)));
    box.querySelectorAll("[data-re]").forEach((b) => (b.onclick = () => { if (window.confirm(`"${b.dataset.re}"를 Claude 초안으로 처음부터 다시 받을까요?\n지금 고친 판은 🕘 이전 판에 남아서 되돌릴 수 있어요.`)) { b.textContent = "받는 중…"; take(b.dataset.re, true); } }));
  });
  $("#modalBody").querySelectorAll("[data-n]").forEach((b) => (b.onclick = () => loadProj(b.dataset.n)));
  $("#modalBody").querySelectorAll("[data-h]").forEach((b) => (b.onclick = () => showHistory(b.dataset.h)));
};
async function showHistory(name) {
  const hs = await api("/api/history?name=" + encodeURIComponent(name));
  const ft = (t) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  modal(`<h3>🕘 ${name} 이전 판</h3><p class="dim" style="font-size:12px">저장할 때마다(3분에 한 번) 남겨요. 고르면 그 판을 지금 프로젝트로 되살려요(지금 판도 기록에 남아요).</p><div class="plist">${hs.map((h) => `<button data-f="${h.file}"><b>${ft(h.t)}</b> · 문장 ${h.n}개<br><span class="dim" style="font-size:12px">${(h.first || "").replace(/</g, "&lt;")}</span></button>`).join("") || '<p class="dim">아직 남은 이전 판이 없어요.</p>'}</div>`);
  $("#modalBody").querySelectorAll("[data-f]").forEach((b) => (b.onclick = async () => {
    const j = await api("/api/history/get?file=" + encodeURIComponent(b.dataset.f)); if (!j || !j.clips) return;
    undoS.push(JSON.stringify(P)); P = j; P.name = name; closeModal(); afterLoad(); relink();
    await api("/api/project", Object.assign({}, P, { _snap: true })); $("#saveState").textContent = "이전 판으로 되살림 " + new Date().toLocaleTimeString() + " (Ctrl+Z로 취소)";
  }));
}
function modal(html) { $("#modalBody").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }
$("#modalClose").onclick = closeModal;

// ------------------------------------------------------------ 탭: 대본 추천 · 영상 찾기 ----
document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("on", x.id === "tab-" + b.dataset.tab));
}));
let SCRIPT = null;
// ---- 영상 먼저 → 대본 ----
const chPrefix = () => ($("#chSel").value === "sobang" ? "소방_" : "지구_");
$("#topic").addEventListener("change", () => { if (!$("#folder").value) $("#folder").value = chPrefix() + $("#topic").value.trim().replace(/\s+/g, ""); });
const folderOf = () => ($("#folder").value.trim() || chPrefix() + $("#topic").value.trim().replace(/\s+/g, ""));
$("#btnCollect").onclick = async () => {
  if (!$("#topic").value.trim()) { alert("주제를 먼저 적어 주세요"); return; }
  const folder = folderOf(); $("#folder").value = folder;
  await api("/api/collect", { channel: $("#chSel").value, topic: $("#topic").value, n: +$("#nClip").value, orient: P.h > P.w ? "portrait" : "", folder, ...condOpt() });
  const tick = async () => { const st = await api("/api/collect/status", { folder }); $("#colState").textContent = (st.state || "") + (st.keywords ? " · 검색어: " + st.keywords.join(", ") : ""); await loadMedia(); if (!st.done) setTimeout(tick, 2000); };
  tick();
};
function folderMedia() {
  const f = "sources/" + folderOf() + "/";
  let ids = Object.values(MEDIA).filter((m) => m.kind === "video" && (m.rel || "").startsWith(f)).map((m) => m.id);
  if (!ids.length) ids = Object.values(MEDIA).filter((m) => m.kind === "video").map((m) => m.id);
  return ids;
}
$("#btnFromMedia").onclick = async () => {
  const ids = folderMedia(); if (!ids.length) { alert("영상이 없어요. ①로 모으거나 미디어 탭에서 가져오세요."); return; }
  if (Object.values(MEDIA).some((m) => m.status === "working")) { alert("영상 준비가 아직 안 끝났어요. 썸네일이 다 뜬 뒤 눌러 주세요."); return; }
  $("#recOut").innerHTML = `<p class="dim">영상 ${ids.length}개를 보고 대본을 쓰는 중이에요(1~2분)…</p>`;
  const r = await api("/api/script_from_media", { channel: $("#chSel").value, topic: $("#topic").value, ids, n: +$("#nSent").value });
  if (r.error) { $("#recOut").innerHTML = `<p style="color:#ff8a65">${r.error}</p>`; return; }
  SCRIPT = { script: r }; showMediaScript();
};
const estDur = (ko) => Math.max(2.2, (ko || "").replace(/[\s,.?!]/g, "").length / 6.3 + 0.5);   // 8번 목소리 대략 속도
function showMediaScript() {
  const r = SCRIPT.script; const th = (id) => (id && MEDIA[id] ? `<img src="/media/${id}/thumb.jpg" style="width:56px;height:56px;object-fit:cover;border-radius:4px;float:right;margin-left:6px">` : "");
  let h = `<p><b>${r.title || ""}</b><br><span class="dim">${r.hook || ""}</span></p>`;
  h += `<div class="row"><button id="btnPlace">타임라인에 배치</button><button id="btnSaveSc">대본 저장</button></div>`;
  if (r.clips_note?.length) h += `<details><summary class="dim">영상 메모</summary>${r.clips_note.map((c) => `<div class="sent">${th(c.media)}<b>${c.clip}</b> ${c.what || ""}${c.species_ok === false ? ' <span style="color:#ff8a65">· 다른 종</span>' : ""}</div>`).join("")}</details>`;
  h += r.sentences.map((x, i) => `<div class="sent">${th(x.media)}<div class="ko">${i + 1}. ${x.ko}</div><div class="en">${x.en || ""}</div><div class="en">화면 ${x.clip || "?"} ${x.clip_in ?? 0}초 · 근거: ${x.fact_source || "?"}</div></div>`).join("");
  $("#recOut").innerHTML = h;
  $("#btnPlace").onclick = placeScript;
  $("#btnSaveSc").onclick = async () => { const a = await api("/api/save_script", { folder: folderOf(), script: r }); $("#btnSaveSc").textContent = a.ok ? "저장됨 ✓" : "실패"; };
}
function placeScript() {
  // 내레이션이 아직 없으니 글자 수로 문장 길이를 어림해서 자막(T1)과 영상(V1)을 나란히 놓아요. 내레이션을 만들면 실제 시간으로 다시 맞춰요.
  snap(); const r = SCRIPT.script; let s0 = 0;
  P.clips = P.clips.filter((c) => !(c.fromScript));
  r.sentences.forEach((x, i) => {
    const d = estDur(x.ko);
    P.clips.push({ id: uid(), track: "T1", kind: "text", fromScript: true, start: s0, in: 0, dur: d, text: x.ko, en: x.en, size: 52, color: "#ffffff", y: 0.7, stroke: 7, n: i + 1 });
    const m = MEDIA[x.media];
    if (m) { const cin = Math.max(0, Math.min(+x.clip_in || 0, Math.max(0, m.dur - 0.5))); P.clips.push({ id: uid(), track: "V1", kind: "video", fromScript: true, media: m.id, src: m.rel || m.path, start: s0, in: cin, dur: Math.min(d, m.dur - cin), vol: 0, fit: "cover", zoom: 1, x: 0.5, y: 0.5, speed: 1 }); }
    s0 += d;
  });
  if (!$("#projName").value || $("#projName").value === "새 프로젝트") $("#projName").value = folderOf();
  renderTL(); draw(); dirty();
}
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
const SRC_NAME = { pexels: "Pexels", pixabay: "Pixabay", commons: "위키미디어", nasa: "NASA" };
let FOUND = [];
const condOpt = () => ({ level: $("#condLv").value, review: $("#condRv").checked });
const COND_COLOR = { free: "#7fe08a", nasa: "#7fd0ff", by: "#ffd54a", bysa: "#ffb347", review: "#ff8a65" };
try { const cl = localStorage.getItem("condLv"); if (cl) $("#condLv").value = cl; } catch (e) {}
$("#condLv").onchange = () => { try { localStorage.setItem("condLv", $("#condLv").value); } catch (e) {} };
$("#btnCredits").onclick = async () => {
  const r = await api("/api/credits_text", { folder: folderOf() });
  modal(`<h3>출처 문구 — ${folderOf()}</h3><p class="dim" style="font-size:12px">업로드 설명란에 붙여 넣으세요. 출처 표시가 필요한 영상은 빠짐없이 들어 있어요.</p><textarea style="width:100%;min-height:220px;background:#262b34;color:var(--fg);border:1px solid var(--line);border-radius:6px">${r.text.replace(/</g, "&lt;")}</textarea>`);
};
function showFound(items, desc = true) {
  FOUND = items;
  const esc = (x) => String(x ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  $("#findOut").innerHTML = items.map((it, i) => `<div class="fi"><img src="${esc(it.thumb)}" alt="" loading="lazy" title="${esc(it.title || it.kw || "")}"><div class="meta"><div class="ko" data-ko="${i}" style="color:var(--fg);font-weight:700">${desc ? "…" : esc(it.ko || "")}</div><span style="display:inline-block;padding:0 5px;border-radius:4px;background:${COND_COLOR[it.cond] || "#888"};color:#111;font-weight:700">${esc(it.cond_ko || "")}</span><br><b>${SRC_NAME[it.source] || it.source}</b>${it.w ? " · " + it.w + "×" + it.h : ""}${it.dur ? " · " + it.dur + "초" : ""}<br><span title="${esc(it.license)}">${esc((it.license || "").slice(0, 28))}</span>${it.author ? " · " + esc(it.author.slice(0, 24)) : ""} <a href="${esc(it.page)}" target="_blank" style="color:#7fd0ff">원본</a></div><button data-i="${i}">받아서 넣기</button></div>`).join("") || '<p class="dim">없어요.</p>';
  $("#findOut").querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => takeItem(+b.dataset.i, b)));
  if (desc && items.length) api("/api/describe", { items }).then((r) => {   // 한 줄 한국어 설명
    (r.items || []).forEach((x) => { if (items[x.i]) { items[x.i].ko = x.ko; items[x.i].topic = x.topic; } const el = document.querySelector(`[data-ko="${x.i}"]`); if (el) el.textContent = x.ko || ""; });
    document.querySelectorAll("[data-ko]").forEach((el) => { if (el.textContent === "…") el.textContent = items[+el.dataset.ko]?.title?.slice(0, 30) || ""; });
  });
}
// 받으면 바로 대본 추천(11-06 "받은 것은 바로 대본을 추천해서 넣어 주면"): 받기가 끝나고 8초 동안 더 받지 않으면, 이 폴더 영상으로 대본을 추천받아 타임라인에 배치
let autoT = null;
async function takeItem(i, b) {
  const it = FOUND[i];
  if (!$("#topic").value.trim() && it.topic) $("#topic").value = it.topic;
  if (!$("#folder").value.trim()) $("#folder").value = chPrefix() + ($("#topic").value.trim() || it.topic || it.kw || "새주제").replace(/\s+/g, "");
  b.textContent = "받는 중…"; b.disabled = true;
  const f = await api("/api/fetch", { ...it, folder: $("#folder").value.trim() });
  b.textContent = f.error ? "실패" : "받음 ✓"; if (f.error) { b.title = f.error; return; }
  loadMedia();
  if ($("#autoSc").checked) { clearTimeout(autoT); $("#autoState").textContent = "더 받을 게 없으면 8초 뒤 대본 추천을 시작해요…"; autoT = setTimeout(autoScript, 8000); }
}
async function autoScript() {
  await waitAllReady(); $("#autoState").textContent = "받은 영상으로 대본을 쓰는 중(1~2분)…";
  SCRIPT = null; document.querySelector('[data-tab="script"]').click(); await $("#btnFromMedia").onclick();
  if (SCRIPT?.script?.sentences) { placeScript(); $("#autoState").textContent = "대본을 추천해서 타임라인에 넣었어요 ✓ (대본 추천 탭에서 확인)"; }
  else $("#autoState").textContent = "대본 추천을 못 했어요(대본 추천 탭의 안내 확인)";
}
async function waitAllReady() { for (let k = 0; k < 300; k++) { await loadMedia(); if (!Object.values(MEDIA).some((m) => m.status === "working")) return; await new Promise((r) => setTimeout(r, 1500)); } }
async function findSimilar(mid) {
  document.querySelector('[data-tab="find"]').click();
  $("#findOut").innerHTML = `<p class="dim">「${MEDIA[mid]?.name || ""}」 장면을 보고 이어 붙일 영상을 찾는 중(20~40초)…</p>`;
  const r = await api("/api/similar", { id: mid, ...condOpt() });
  if (r.error) { $("#findOut").innerHTML = `<p style="color:#ff8a65">${r.error}</p>`; return; }
  (r.items || []).forEach((it) => (it.ko = (it.why ? it.why + " · " : "") + (it.title || it.kw || "").slice(0, 30)));
  showFound(r.items || [], false);
  $("#findOut").insertAdjacentHTML("afterbegin", `<div style="grid-column:1/-1;font-size:12px" class="dim">🔗 <b style="color:var(--fg)">${r.subject || ""}</b>에 이어 붙일 영상 · 검색어: ${(r.keywords || []).map((k) => `${k.q}(${k.why})`).join(", ")}</div>`);
}
$("#btnFind").onclick = async () => {
  $("#findOut").innerHTML = '<p class="dim">찾는 중…</p>';
  const r = await api("/api/search", { q: $("#q").value, source: $("#src").value, orient: $("#orient").value, ...condOpt() });
  if (r.error) { $("#findOut").innerHTML = `<p style="color:#ff8a65">${r.error}</p>`; return; }
  showFound(r.items);
};
$("#btnWonder").onclick = async () => {
  $("#findOut").innerHTML = '<p class="dim">신기한 영상을 여러 곳에서 찾는 중(20~40초)…</p>';
  const r = await api("/api/wonder", condOpt()); showFound(r.items || []);
};
$("#btnKeys").onclick = () => {
  modal(`<h3>키 설정</h3><p class="dim" style="font-size:12px">여기 넣은 키는 구글 드라이브 01_쇼츠\\_private\\sumgyeol_keys.json 에 저장돼서 두 PC가 같이 써요(채팅에는 안 올라가요). 비워 두면 그대로 둬요.</p>
  <label>Pexels API 키 <a href="https://www.pexels.com/api/" target="_blank" style="color:#7fd0ff">받기</a><input id="kPx" type="password" style="width:100%"></label>
  <label>Pixabay API 키 <a href="https://pixabay.com/api/docs/" target="_blank" style="color:#7fd0ff">받기</a><input id="kPb" type="password" style="width:100%"></label>
  <label>Claude API 키 <a href="https://console.anthropic.com/settings/keys" target="_blank" style="color:#7fd0ff">받기</a><input id="kCl" type="password" style="width:100%"></label>
  <div class="row end"><button id="kSave">저장</button></div>`);
  $("#kSave").onclick = async () => { await api("/api/keys/set", { pexels: $("#kPx").value, pixabay: $("#kPb").value, anthropic: $("#kCl").value }); closeModal(); initTop(); };
};
$("#btnPx").onclick = async () => {
  const urls = $("#pxUrls").value.split(/\s+/).filter(Boolean); const folder = $("#folder")?.value.trim() || ""; let ok = 0;
  for (let i = 0; i < urls.length; i++) { $("#pxState").textContent = `받는 중 ${i + 1}/${urls.length}…`; const r = await api("/api/fetch_pexels", { url: urls[i], folder }); if (!r.error) ok++; else $("#pxState").textContent = r.error; }
  $("#pxState").textContent = `${ok}/${urls.length}개 받음 → 미디어 탭`; loadMedia();
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

// ------------------------------------------------------------ 문장 탭(11-06 "자막을 고치고 코멘트로 영상·사진·Veo 요청") ----
const sentClips = () => P.clips.filter((c) => c.kind === "text").sort((a, b) => a.start - b.start);
function projFolder() {
  if (P.folder) return P.folder;
  const v = P.clips.find((c) => (c.src || "").startsWith("sources/")); if (v) return v.src.split("/")[1];
  return folderOf();
}
function vAt(tt) { return P.clips.filter((c) => c.track === "V1" && tt >= c.start && tt < c.start + c.dur).sort((a, b) => b.start - a.start)[0]; }
function renderSents() {
  const box = $("#sentList"); if (!box) return; const ss = sentClips();
  if (!ss.length) { box.innerHTML = '<p class="dim">글자 트랙에 문장이 없어요. 대본 추천이나 자막(.srt) 불러오기로 넣어 주세요.</p>'; return; }
  const head = `<div class="row" style="flex-wrap:wrap"><button id="btnArrange">🎬 대본에 맞춰 영상 재배치</button><button id="btnVoiceAll">🔊 모든 문장 목소리 다시 만들기</button></div><div id="voiceState" class="dim" style="font-size:12px"></div>`;
  box.innerHTML = head + ss.map((c, i) => { const v = vAt(c.start + Math.min(0.5, c.dur / 2)); const th = v && MEDIA[v.media] ? (MEDIA[v.media].kind === "image" ? `/media/${v.media}/thumb.jpg` : `/media/${v.media}/thumb.jpg`) : "";
    return `<div class="srow" data-id="${c.id}"><div class="hdr"><b>${c.n || i + 1}</b> ${fmt(c.start)} · ${c.dur.toFixed(1)}초 <button data-act="go" title="이 문장으로 가서 재생">▶</button>${v?.ai ? ' <span style="color:#ff8a65">AI</span>' : ""}${th ? `<img src="${th}" title="지금 화면: ${MEDIA[v.media].name}">` : '<img alt="">'}</div>
    <textarea data-act="text">${(c.text || "").replace(/</g, "&lt;")}</textarea>
    <div class="row" style="margin:4px 0 0"><input class="memo" data-act="speak" style="margin:0" placeholder="읽는 법(비우면 자동: 숫자→한글)" value="${(c.speak || "").replace(/"/g, "&quot;")}"><button data-act="voice" style="font-size:12px;padding:3px 7px;white-space:nowrap">🔊 목소리${c.voice && MEDIA[c.voice] ? " ✓" : ""}</button></div>
    <input class="memo" data-act="memo" placeholder="코멘트·요청(예: 해달이 털 고르는 클로즈업, 바다 위에서)" value="${(c.memo || "").replace(/"/g, "&quot;")}">
    <div class="btns"><button data-act="cut" class="on" title="원본을 돌려 보며 I·O를 찍어 이 문장 자리에 넣기">✂ 구간 뜨기</button><button data-act="vid">🎬 쓸만한 영상</button><button data-act="img">🖼 어울리는 사진</button><button data-act="veo">✨ Veo 만들기</button>${c.veo ? '<button data-act="veoin">📥 Veo 클립 넣고 검수</button>' : ""}<button data-act="ask" class="${c.veoAsk ? "on" : ""}" title="이 문장 Veo를 Claude에게 맡겨요(저장 후 채팅에 'Veo 맡겼어')">🤖 ${c.veoAsk ? "Claude에게 맡김 ✓" : "Claude에게 맡기기"}</button></div>
    <div class="res">${c.veo ? veoHtml(c.veo) : ""}</div></div>`; }).join("");
  $("#btnArrange").onclick = arrangeAll;
  $("#btnVoiceAll").onclick = async () => { const all = sentClips(); for (let k = 0; k < all.length; k++) { $("#voiceState").textContent = `목소리 만드는 중 ${k + 1}/${all.length}…`; const ok = await sentVoice(all[k], true); if (!ok) break; } $("#voiceState").textContent = "다 만들었어요 ✓"; renderSents(); };
  box.querySelectorAll(".srow").forEach((row) => {
    const c = clipById(row.dataset.id);
    row.querySelector('[data-act="text"]').oninput = (e) => { c.text = e.target.value; draw(); renderTL(); dirty(); };
    row.querySelector('[data-act="memo"]').oninput = (e) => { c.memo = e.target.value; dirty(); };
    row.querySelector('[data-act="speak"]').oninput = (e) => { c.speak = e.target.value; dirty(); };
    row.querySelector('[data-act="voice"]').onclick = async (e) => { e.target.textContent = "🔊 만드는 중…"; await sentVoice(c); renderSents(); };
    row.querySelector('[data-act="go"]').onclick = () => { sel = c.id; seek(c.start); togglePlay(true); };
    row.querySelector('[data-act="cut"]').onclick = () => openSrcMon({ sid: c.id });
    row.querySelector('[data-act="vid"]').onclick = () => sentFind(c, row, "video");
    row.querySelector('[data-act="img"]').onclick = () => sentFind(c, row, "image");
    row.querySelector('[data-act="veo"]').onclick = () => sentVeo(c, row);
    const vi = row.querySelector('[data-act="veoin"]'); if (vi) vi.onclick = () => veoImport(c, row);
    row.querySelector('[data-act="ask"]').onclick = async () => { c.veoAsk = !c.veoAsk; if (c.veoAsk && !c.veo) await sentVeo(c, row); dirty(); await save(); renderSents(); flash(c.veoAsk ? "맡겼어요 — 채팅에 'Veo 맡겼어'라고 알려 주세요" : "맡기기를 취소했어요"); };
    bindVeo(row, c);
  });
}
// 목소리(11-07 "음성도 자막 넣을 때 같이"): 이 문장 글(또는 읽는 법)로 8번 목소리를 만들어 소리 트랙에 넣고, 문장 길이를 목소리에 맞춰 뒤를 밀거나 당겨요
async function sentVoice(c, quiet) {
  const poll = setInterval(async () => { const st = await api("/api/tts/status", {}); if (st.state && !st.ready) ($("#voiceState") || {}).textContent = st.state; }, 1500);
  const r = await api("/api/tts", { text: c.text, speak: c.speak || "", folder: projFolder() }); clearInterval(poll);
  if (r.error) { if (!quiet) alert(r.error); else $("#voiceState").textContent = r.error; return false; }
  c.speak = r.speak; await waitAllReady(); placeVoice(c, r.id, r.dur); return true;
}
function placeVoice(c, mid, dur) {
  snap(); const pause = 0.45, slot = Math.max(1, dur + pause), oldEnd = c.start + c.dur, delta = slot - c.dur;
  cutRange("A1", c.start, oldEnd);
  P.clips.forEach((x) => { if (x.id !== c.id && x.start >= oldEnd - 1e-3) x.start += delta; });   // 뒤를 밀거나 당기기
  P.clips.filter((x) => x.track === "V1" && x.start < oldEnd - 1e-3 && x.start + x.dur >= oldEnd - 0.05).forEach((x) => (x.dur = Math.max(0.3, x.dur + delta)));
  c.dur = slot; c.voice = mid;
  P.clips.push({ id: uid(), track: "A1", kind: "audio", media: mid, src: MEDIA[mid].rel || MEDIA[mid].path, start: c.start, in: 0, dur, vol: 1, speed: 1, voiceOf: c.id });
  renderTL(); draw(); dirty();
}
// 🎬 대본에 맞춰 영상 재배치(11-07 "해달편 대본에 맞춰서 영상 재배치"): 이 편 폴더의 영상·사진 + 지금 타임라인의 클립을 Claude가 보고 문장마다 다시 붙여요
async function arrangeAll() {
  const ss = sentClips(); if (!ss.length) return; const st = $("#voiceState");
  const f = "sources/" + projFolder() + "/";
  const ids = [...new Set([...Object.values(MEDIA).filter((m) => (m.kind === "video" || m.kind === "image") && (m.rel || "").startsWith(f) && !(m.rel || "").includes("/voice/")).map((m) => m.id),
                          ...P.clips.filter((c) => c.track === "V1" && MEDIA[c.media]).map((c) => c.media)])];
  if (!ids.length) { alert("이 편 폴더에 영상이 없어요"); return; }
  st.textContent = `Claude가 영상 ${ids.length}개를 보고 문장 ${ss.length}개에 맞추는 중(1~2분)…`;
  const r = await api("/api/arrange", { topic: $("#topic").value || P.name, ids, sentences: ss.map((c, i) => ({ i: i + 1, text: c.text, dur: c.dur })) });
  if (r.error || !r.plan) { st.textContent = r.error || "재배치를 못 했어요"; return; }
  snap(); let n = 0;
  for (const x of r.plan) {
    const c = ss[(x.i || 0) - 1], m = MEDIA[x.media]; if (!c || !m) continue;
    const isImg = m.kind === "image"; const cin = isImg ? 0 : Math.max(0, Math.min(+x.clip_in || 0, Math.max(0, m.dur - Math.min(c.dur, m.dur))));
    const k = placeInRange(m.id, c.start, c.dur, isImg, { in: cin, why: x.why || "" });
    if (!isImg) { k.dur = c.dur; k.speed = m.dur - cin < c.dur ? Math.max(0.5, +((m.dur - cin) / c.dur).toFixed(2)) : 1; } n++;
  }
  undoS.splice(undoS.length - n, n);   // 한 번의 되돌리기(Ctrl+Z)로 재배치 전체를 돌려요
  renderTL(); draw(); dirty(); renderSents();
  $("#voiceState").textContent = `문장 ${n}개에 영상을 다시 붙였어요 ✓ (Ctrl+Z로 되돌리기)` + (r.notes ? " · " + r.notes : "");
}
// 🤖 클립 코멘트로 고치기: 대본(글자·목소리)은 그대로, 이 클립 구간의 화면만 바꿔요
async function clipFix(c) {
  const out = $("#fixOut"); const memo = ($("#fixMemo").value || "").trim(); if (!memo) { out.textContent = "코멘트를 먼저 적어 주세요"; return; }
  c.memo = memo; out.textContent = "🤖 장면을 보고 고치는 중(20~40초)…";
  const sent = P.clips.filter((x) => x.kind === "text" && x.start <= c.start + 0.05 && x.start + x.dur > c.start + 0.05)[0] || sentClips().find((x) => x.start + x.dur > c.start);
  const f = "sources/" + projFolder() + "/";
  const cand = Object.values(MEDIA).filter((m) => (m.kind === "video" || m.kind === "image") && (m.rel || "").startsWith(f) && !(m.rel || "").includes("/voice/")).map((m) => m.id);
  const r = await api("/api/clip_fix", { id: c.media, text: sent?.text || "", comment: memo, cand, dur: c.dur, in: c.in || 0 });
  if (r.error) { out.textContent = r.error; return; }
  c.fixReply = r.reply_ko || ""; const st = c.start, d = c.dur;
  if (r.action === "replace" && MEDIA[r.media]) {
    const m = MEDIA[r.media], isImg = m.kind === "image", cin = isImg ? 0 : Math.max(0, Math.min(+r.clip_in || 0, Math.max(0, m.dur - Math.min(d, m.dur))));
    const k = placeInRange(m.id, st, d, isImg, { in: cin, memo, fixReply: c.fixReply });
    if (!isImg) { k.dur = d; k.speed = m.dur - cin < d ? Math.max(0.5, +((m.dur - cin) / d).toFixed(2)) : 1; }
    renderTL(); renderInsp(); draw();
  } else if (r.action === "adjust") {
    snap(); for (const key of ["zoom", "zoomEnd", "x", "y", "speed"]) if (typeof r[key] === "number") c[key] = r[key];
    if (typeof r.clip_in === "number") c.in = Math.max(0, r.clip_in);
    if (r.zoomEnd != null) { c.xEnd = c.xEnd ?? c.x; c.yEnd = c.yEnd ?? c.y; }
    renderTL(); renderInsp(); draw(); dirty();
  } else if (r.action === "search") {
    renderInsp(); $("#fixOut").textContent = "🤖 " + c.fixReply + " → 새 영상 후보를 찾는 중…";
    document.querySelector('[data-tab="find"]').click(); $("#q").value = r.search_query || sent?.text || ""; $("#btnFind").click(); return;
  } else if (r.action === "veo") {
    if (sent) { sent.memo = (sent.memo ? sent.memo + " / " : "") + memo; document.querySelector('[data-tab="sent"]').click(); const row = document.querySelector(`.srow[data-id="${sent.id}"]`); if (row) await sentVeo(sent, row); }
  }
  dirty(); const o2 = $("#fixOut"); if (o2) o2.textContent = "🤖 " + c.fixReply;
}
function veoHtml(v) {
  const esc = (x) => String(x ?? "").replace(/</g, "&lt;");
  return `<div class="veo"><b>✨ Veo 프롬프트</b> <button data-act="cp" style="font-size:11px;padding:1px 6px">복사</button> <a href="https://labs.google/fx/tools/flow" target="_blank" style="color:#7fd0ff">Flow 열기</a>
  <textarea readonly>${esc(v.prompt_en)}${v.avoid_en ? "\n\nAvoid: " + esc(v.avoid_en) : ""}</textarea>
  ${v.shot_ko ? `<div>📷 샷: ${esc(v.shot_ko)}</div>` : ""}${v.camera_ko ? `<div>🎥 카메라: ${esc(v.camera_ko)}</div>` : ""}${v.light_ko ? `<div>💡 빛: ${esc(v.light_ko)}</div>` : ""}
  ${(v.tips_ko || []).length ? `<div>요령:<ul>${v.tips_ko.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
  <div>검수 항목:<ul>${(v.checklist_ko || []).map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>
  <div class="dim">Flow에서 9:16·8초로 만들고 받은 파일을 "📥 Veo 클립 넣고 검수"로 넣으세요. AI 영상은 유튜브 업로드 때 "변경되거나 합성된 콘텐츠: 예"로 표시해요(수익 창출 가능).</div>
  ${v.check ? checkHtml(v.check) : ""}</div>`;
}
function checkHtml(r) {
  const esc = (x) => String(x ?? "").replace(/</g, "&lt;");
  return `<div style="margin-top:6px;padding:6px;border-radius:6px;background:${r.pass ? "#1d3324" : "#3a2020"}"><b>🔍 검수 ${r.pass ? "통과" : "다시 만들기 권장"} (${r.score}점)</b>
  ${(r.good_ko || []).length ? `<div>좋은 점:<ul>${r.good_ko.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
  ${(r.issues_ko || []).length ? `<div>문제:<ul>${r.issues_ko.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>` : ""}
  ${r.fix_prompt_en ? `<div>고친 프롬프트:<textarea readonly style="min-height:70px">${esc(r.fix_prompt_en)}</textarea></div>` : ""}</div>`;
}
function bindVeo(row, c) { const b = row.querySelector('[data-act="cp"]'); if (b) b.onclick = () => { navigator.clipboard?.writeText(c.veo.prompt_en + (c.veo.avoid_en ? "\n\nAvoid: " + c.veo.avoid_en : "")); b.textContent = "복사됨"; }; }
async function sentFind(c, row, kind) {
  const res = row.querySelector(".res"); res.innerHTML = `<p class="dim">이 문장에 맞는 ${kind === "video" ? "영상" : "사진"}을 찾는 중(20~40초)…</p>`;
  const r = await api("/api/sent_search", { text: c.text, note: c.memo || "", topic: $("#topic").value || P.name, channel: $("#chSel").value, kind, ...condOpt() });
  const items = r.items || [];
  if (!items.length) { res.innerHTML = `<p class="dim">못 찾았어요. ${r.error || "코멘트에 원하는 장면을 영어/한국어로 적고 다시 눌러 보세요."}</p>`; return; }
  const esc = (x) => String(x ?? "").replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[ch]));
  res.innerHTML = `<div class="dim" style="font-size:11px">검색어: ${(r.keywords || []).map((k) => k.q).join(", ")}</div><div class="grid">` + items.slice(0, 12).map((it, i) => `<div class="fi"><img src="${esc(it.thumb)}" loading="lazy"><div class="meta"><span style="display:inline-block;padding:0 4px;border-radius:4px;background:${COND_COLOR[it.cond] || "#888"};color:#111;font-weight:700">${esc(it.cond_ko)}</span><br>${esc(it.why || "")}<br>${SRC_NAME[it.source] || it.source}${it.dur ? " · " + it.dur + "초" : ""} <a href="${esc(it.page)}" target="_blank" style="color:#7fd0ff">원본</a></div><button data-k="${i}">이 문장에 넣기</button></div>`).join("") + "</div>";
  res.querySelectorAll("[data-k]").forEach((b) => (b.onclick = async () => {
    b.textContent = "받는 중…"; b.disabled = true;
    const f = await api("/api/fetch", { ...items[+b.dataset.k], folder: projFolder() });
    if (f.error || !f.ids?.length) { b.textContent = "실패"; b.title = f.error || ""; return; }
    await waitAllReady(); placeInRange(f.ids[0], c.start, c.dur, items[+b.dataset.k].kind === "image"); b.textContent = "넣음 ✓"; renderSents();
  }));
}
function cutRange(track, st, en) {   // 트랙의 [st, en] 구간을 비워요(걸친 클립은 자르고, 안에 든 클립은 지움)
  for (const x of P.clips.filter((x) => x.track === track)) {
    const xs = x.start, xe = x.start + x.dur; if (xe <= st + 1e-3 || xs >= en - 1e-3) continue;
    if (xs >= st && xe <= en) { P.clips = P.clips.filter((y) => y !== x); continue; }
    if (xs < st && xe > en) { splitAtRaw(x, en); x.dur = st - xs; continue; }
    if (xs < st) { x.dur = st - xs; x.fadeOut = 0; continue; }
    const cut = en - xs; x.in += cut * (x.speed || 1); x.start = en; x.dur -= cut; x.fadeIn = 0;
  }
  P.clips = P.clips.filter((x) => !(x.track === track && x.dur < 0.2));   // 자투리 정리
}
function placeInRange(mid, st, d, isImg, extra) {   // 이 문장 구간[st, st+d]의 영상 트랙을 새 클립으로 바꿔요(겹친 클립은 자르거나 비켜요)
  snap(); const en = st + d, m = MEDIA[mid]; cutRange("V1", st, en);
  const c = { id: uid(), track: "V1", kind: isImg ? "image" : "video", media: mid, src: m.rel || m.path, start: st, in: 0, dur: isImg ? d : Math.min(d, m.dur), vol: 0, fit: "cover", zoom: 1, x: 0.5, y: 0.5, speed: 1, fadeIn: 0.3, ...(extra || {}) };
  if (isImg) { c.zoomEnd = 1.15; c.xEnd = 0.5; c.yEnd = 0.5; }
  if (!isImg && m.dur < d) c.speed = Math.max(0.5, +(m.dur / d).toFixed(2)), c.dur = d;   // 짧으면 살짝 느리게 해서 채워요
  P.clips.push(c); sel = c.id; renderTL(); renderInsp(); draw(); dirty(); return c;
}
async function sentVeo(c, row) {
  const ss = sentClips(), i = ss.indexOf(c); const res = row.querySelector(".res"); res.innerHTML = '<p class="dim">이 문장에 맞는 Veo 프롬프트를 쓰는 중…</p>';
  const r = await api("/api/veo_prompt", { text: c.text, note: c.memo || "", topic: $("#topic").value || P.name, prev: ss[i - 1]?.text || "", next: ss[i + 1]?.text || "" });
  if (r.error) { res.innerHTML = `<p style="color:#ff8a65">${r.error}</p>`; return; }
  c.veo = r; dirty(); renderSents();
}
async function veoImport(c, row) {
  const before = new Set(Object.keys(MEDIA)); const res = row.querySelector(".res");
  res.insertAdjacentHTML("beforeend", '<p class="dim">PC에서 Veo로 만든 파일을 고르세요…</p>');
  await api("/api/pick", {}); await waitAllReady();
  const mid = Object.keys(MEDIA).find((id) => !before.has(id) && MEDIA[id].kind === "video"); if (!mid) { renderSents(); return; }
  placeInRange(mid, c.start, c.dur, false, { ai: true, veoPrompt: c.veo.prompt_en });
  res.insertAdjacentHTML("beforeend", '<p class="dim">🔍 Claude가 장면을 보고 검수하는 중…</p>');
  const r = await api("/api/veo_check", { id: mid, text: c.text, prompt: c.veo.prompt_en, checklist: c.veo.checklist_ko });
  c.veo.check = r.error ? { pass: false, score: 0, issues_ko: [r.error] } : r; dirty(); renderSents();
}
document.querySelector('[data-tab="sent"]').addEventListener("click", renderSents);

// ------------------------------------------------------------ 미리보기 내보내기(11-07 "너가 만든 영상 줘봐") ----
// 화면(캔버스)과 소리를 실제 재생 속도로 녹화 → 서버가 mp4로 바꿔 sources\<폴더>\미리보기_<이름>.mp4 에 저장하고 열어 줘요.
let AC = null, ADEST = null; const ACONN = new Set();
function audioRoute(e) {
  if (!AC) { AC = new AudioContext(); ADEST = AC.createMediaStreamDestination(); }
  if (ACONN.has(e)) return; const src = AC.createMediaElementSource(e); src.connect(AC.destination); src.connect(ADEST); ACONN.add(e);
}
async function exportPreview() {
  if (!P.clips.length) return; if (playing) togglePlay(false);
  const ov = document.createElement("div"); ov.id = "updOv"; document.body.appendChild(ov);
  ov.textContent = "미리보기 준비 중(영상 불러오기)…"; await waitAllReady();
  const ms = [...new Set(P.clips.filter((c) => c.media && MEDIA[c.media]).map((c) => c.media))];
  await Promise.all(ms.map((id) => new Promise((res) => { const e = elFor(MEDIA[id]); if (MEDIA[id].kind === "image") { e.complete ? res() : (e.onload = res); return; } audioRoute(e); if (e.readyState >= 3) res(); else { e.addEventListener("canplaythrough", res, { once: true }); setTimeout(res, 8000); e.load(); } })));
  await AC.resume();
  const stream = cv.captureStream(30); ADEST.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10e6 }); const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((res) => (rec.onstop = res));
  seek(0); await new Promise((r) => setTimeout(r, 600));
  rec.start(1000); togglePlay(true); const total = projDur();
  const tick = setInterval(() => (ov.textContent = `🎬 미리보기 녹화 중 ${fmt(t)} / ${fmt(total)} — 이 탭을 그대로 띄워 두세요`), 250);
  while (playing) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 400)); rec.stop(); await done; clearInterval(tick);
  ov.textContent = "mp4로 바꾸는 중…";
  const blob = new Blob(chunks, { type: "video/webm" });
  const r = await fetch(`/api/export_upload?name=${encodeURIComponent(P.name)}&folder=${encodeURIComponent(projFolder())}`, { method: "POST", body: blob }).then((x) => x.json());
  ov.textContent = r.error ? "실패: " + r.error : "✓ 미리보기 저장: " + r.path; setTimeout(() => ov.remove(), 8000);
}
$("#btnExport").onclick = exportPreview; $("#btnSnd").onclick = soundDiag;

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
    if (!a.restart) { location.reload(); return; }   // 화면만 바뀐 업데이트
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

// ------------------------------------------------------------ ✂ 원본에서 구간 뜨기 ----
// 11-07 "대본을 내가 원하는 대로 클립을 뜰 수 있게": 문장을 고르고, 원본 영상을 돌려 보며 I(시작)·O(끝)를 찍어 그 문장 자리에 넣어요(프리미어 소스 모니터처럼)
const SM = { open: false, mid: null, i: null, o: null, sid: null, fromClip: null, cur: {}, all: false };
const smV = document.createElement("video"); smV.playsInline = true; smV.preload = "auto";
function smSents() { return sentClips(); }
function smSent() { return clipById(SM.sid); }
function smSentAt(tt) { const ss = smSents(); return ss.find((x) => tt >= x.start - 1e-3 && tt < x.start + x.dur) || ss[0]; }
function openSrcMon(opt = {}) {
  if (playing) togglePlay(false);
  const ss = smSents(); if (!ss.length && !opt.fromClip) return alert("글자 트랙에 문장이 없어요. 먼저 대본(자막)을 넣어 주세요.");
  SM.open = true; SM.fromClip = opt.fromClip || null;
  SM.sid = opt.sid || (SM.fromClip ? smSentAt(SM.fromClip.start + 0.05)?.id : (clipById(sel)?.kind === "text" ? sel : smSentAt(t)?.id));
  let ov = $("#srcMon"); if (!ov) { ov = document.createElement("div"); ov.id = "srcMon"; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="smTop"><b>✂ 원본에서 구간 뜨기</b>
      <button id="smPrev" title="앞 문장 ([)">◀</button><select id="smSel"></select><button id="smNext" title="다음 문장 (])">▶</button>
      <span class="grow"></span><span class="dim" style="font-size:12px">I 시작 · O 끝 · 스페이스 재생 · ←→ 한 프레임(Shift 1초) · Enter 채우기 · , 이어 넣기 · Esc 닫기</span><button id="smClose">✕ 닫기</button></div>
    <div id="smSentBox"></div>
    <div class="smBody"><div class="smLeft"><div class="row" style="margin:0 0 6px"><b style="font-size:12px">원본</b><span class="grow"></span><label style="font-size:12px"><input type="checkbox" id="smAll"${SM.all ? " checked" : ""}> 모든 미디어</label></div><div id="smList"></div></div>
      <div class="smMain"><div class="smView"></div>
        <div id="smBar"><div class="rng"></div><div class="ph"></div></div>
        <div class="row" style="justify-content:center;flex-wrap:wrap"><span id="smTc" class="tc">00:00.00</span>
          <button id="smBk">◀︎ 1프레임</button><button id="smPlay">▶ 재생</button><button id="smFw">1프레임 ▶︎</button>
          <button id="smI" class="mk">I 시작 찍기</button><button id="smO" class="mk">O 끝 찍기</button><button id="smPv">⟲ 구간만 보기</button><button id="smClr">찍은 것 지우기</button></div>
        <div id="smInfo" class="dim" style="text-align:center;font-size:13px"></div>
        <div class="row smAct" style="justify-content:center;flex-wrap:wrap">
          <button id="smFill" class="pri" title="Enter">▶ 이 문장 자리를 이 구간으로 채우기</button>
          <button id="smApp" title=",">＋ 이 문장에 이어 넣기</button>
          <button id="smOver" title=".">재생선 자리에 덮어쓰기</button>
          <button id="smRep" class="hidden">↺ 고른 클립을 이 구간으로 바꾸기</button></div>
        <div class="row" style="justify-content:center"><label style="font-size:12px"><input type="checkbox" id="smNextAuto" checked> 문장 자리가 다 차면 다음 문장으로</label></div>
      </div></div>`;
  ov.querySelector(".smView").appendChild(smV);
  $("#smClose").onclick = closeSrcMon; $("#smPrev").onclick = () => smStep(-1); $("#smNext").onclick = () => smStep(1);
  $("#smSel").onchange = (e) => smSetSent(e.target.value);
  $("#smAll").onchange = (e) => { SM.all = e.target.checked; smList(); };
  $("#smBk").onclick = () => smSeek(smV.currentTime - 1 / 30); $("#smFw").onclick = () => smSeek(smV.currentTime + 1 / 30);
  $("#smPlay").onclick = () => smPlay(); $("#smI").onclick = () => smMark("i"); $("#smO").onclick = () => smMark("o");
  $("#smPv").onclick = () => { if (SM.i == null) return; smSeek(SM.i); SM.pvEnd = SM.o ?? null; smV.play(); };
  $("#smClr").onclick = () => { SM.i = SM.o = null; smUpd(); };
  $("#smFill").onclick = smFill; $("#smApp").onclick = smAppend; $("#smOver").onclick = smOver; $("#smRep").onclick = smReplace;
  const bar = $("#smBar"); bar.onmousedown = (e) => { const go = (ev) => { const r = bar.getBoundingClientRect(); smSeek(((ev.clientX - r.left) / r.width) * (smV.duration || 0)); }; go(e); const mv = (ev) => go(ev), up = () => { removeEventListener("mousemove", mv); removeEventListener("mouseup", up); }; addEventListener("mousemove", mv); addEventListener("mouseup", up); };
  smV.ontimeupdate = () => { if (SM.pvEnd != null && smV.currentTime >= SM.pvEnd) { smV.pause(); SM.pvEnd = null; } smUpd(true); };
  smV.onplay = smV.onpause = () => { const b = $("#smPlay"); if (b) b.textContent = smV.paused ? "▶ 재생" : "❚❚ 멈춤"; };
  smV.onloadedmetadata = () => { if (SM._seekTo != null) { smV.currentTime = SM._seekTo; SM._seekTo = null; } smUpd(); };
  if (SM.fromClip) { const c = SM.fromClip; SM.i = c.in; SM.o = c.in + c.dur * (c.speed || 1); smLoad(c.media, c.in, true); }
  else if (opt.mid) smLoad(opt.mid, 0); else if (!SM.mid) { const f = smMedia()[0]; if (f) smLoad(f.id, 0); } else smLoad(SM.mid, smV.currentTime || 0, true);
  smFillSel(); smSetSent(SM.sid, true); smList();
}
function closeSrcMon() { SM.open = false; smV.pause(); const ov = $("#srcMon"); if (ov) ov.remove(); renderTL(); renderInsp(); draw(); if ($("#sentList")) renderSents(); }
function smMedia() {
  const f = "sources/" + projFolder() + "/", ms = Object.values(MEDIA).filter((m) => m.status === "ready" && (m.kind === "video" || m.kind === "image") && !/^veo_|voice/.test(m.name || ""));
  const mine = ms.filter((m) => (m.rel || "").startsWith(f)); return SM.all || !mine.length ? ms : mine;
}
function smList() {
  const box = $("#smList"); if (!box) return;
  const used = new Set(P.clips.filter((c) => c.track === "V1").map((c) => c.media));
  box.innerHTML = smMedia().map((m) => `<div class="smi${m.id === SM.mid ? " on" : ""}" data-m="${m.id}"><img src="/media/${m.id}/thumb.jpg" alt=""><div class="nm">${m.kind === "image" ? "🖼 " : ""}${(m.desc_ko || m.name || "").replace(/</g, "&lt;")}</div><div class="b">${m.kind === "video" ? m.dur.toFixed(1) + "초" : "사진"}${used.has(m.id) ? " · 씀" : ""}</div></div>`).join("") || '<p class="dim">이 편 폴더에 영상이 없어요. "모든 미디어"를 켜 보세요.</p>';
  box.querySelectorAll("[data-m]").forEach((d) => (d.onclick = () => { if (SM.fromClip && d.dataset.m !== SM.fromClip.media) { /* 다른 원본으로 바꿔도 돼요 */ } SM.i = SM.o = null; smLoad(d.dataset.m, 0); smList(); }));
}
function smLoad(mid, at = 0, keep) {
  const m = MEDIA[mid]; if (!m) return; SM.mid = mid; if (!keep) { SM.i = SM.o = null; }
  const v = $(".smView"); if (!v) return;
  v.querySelector("img")?.remove();
  if (m.kind === "image") { smV.pause(); smV.style.display = "none"; const im = new Image(); im.src = `/media/${mid}/proxy.jpg`; v.appendChild(im); }
  else { smV.style.display = ""; const src = `/media/${mid}/proxy.mp4`; if (!smV.src.endsWith(src)) { SM._seekTo = at; smV.src = src; } else smV.currentTime = at; }
  $("#smBar").style.backgroundImage = m.kind === "video" ? `url(/media/${mid}/strip.jpg)` : "none";
  smUpd();
}
function smSeek(s) { if (!smV.duration) return; smV.currentTime = Math.max(0, Math.min(smV.duration - 0.01, s)); smUpd(true); }
function smPlay() { if (MEDIA[SM.mid]?.kind !== "video") return; SM.pvEnd = null; smV.paused ? smV.play() : smV.pause(); }
function smMark(w) { if (MEDIA[SM.mid]?.kind !== "video") return; const x = smV.currentTime; if (w === "i") { SM.i = x; if (SM.o != null && SM.o <= x) SM.o = null; } else { SM.o = x; if (SM.i == null || SM.i >= x) SM.i = Math.max(0, x - 3); } smUpd(); }
function smRange() {   // [시작, 끝] 원본 초. 사진은 문장 길이 전체
  const m = MEDIA[SM.mid]; if (!m) return null;
  if (m.kind === "image") return { a: 0, b: null, len: null };
  const a = SM.i ?? smV.currentTime ?? 0, b = SM.o ?? m.dur; return { a, b, len: Math.max(0, b - a) };
}
function smFillSel() { const s = $("#smSel"); if (!s) return; s.innerHTML = smSents().map((c, k) => `<option value="${c.id}">${c.n || k + 1}. ${(c.text || "").slice(0, 26).replace(/</g, "&lt;")}</option>`).join(""); }
function smSetSent(id, quiet) {
  SM.sid = id; const c = smSent(); const s = $("#smSel"); if (s && id) s.value = id;
  if (c && !quiet) { t = c.start; placeHead(); }
  smSentBox(); smUpd();
}
function smStep(d) { const ss = smSents(), k = ss.findIndex((x) => x.id === SM.sid); const n = ss[Math.max(0, Math.min(ss.length - 1, k + d))]; if (n) smSetSent(n.id); }
function smSentBox() {
  const box = $("#smSentBox"); if (!box) return; const c = smSent(); if (!c) { box.innerHTML = ""; return; }
  const st = c.start, en = c.start + c.dur, cur = SM.cur[c.id] ?? st;
  const vs = P.clips.filter((x) => x.track === "V1" && x.start < en - 0.02 && x.start + x.dur > st + 0.02).sort((a, b) => a.start - b.start);
  box.innerHTML = `<div class="smSent"><b>${c.n || ""}</b> ${(c.text || "").replace(/</g, "&lt;")}</div>
    <div class="smSlot"><span class="dim">이 문장 자리 ${fmt(st)} ~ ${fmt(en)} (${c.dur.toFixed(1)}초)${cur >= en - 0.1 ? " · 다 찼어요 ✓" : cur > st + 0.01 ? ` · 이어 넣을 곳 ${(cur - st).toFixed(1)}초부터` : ""} · 지금 들어 있는 영상(누르면 그 클립을 다시 떠요):</span>
    <div class="slotbar">${vs.map((x) => { const a = Math.max(st, x.start), b = Math.min(en, x.start + x.dur); return `<span class="sc${SM.fromClip?.id === x.id ? " on" : ""}" data-c="${x.id}" style="left:${((a - st) / c.dur) * 100}%;width:${((b - a) / c.dur) * 100}%;background-image:url(/media/${x.media}/thumb.jpg)" title="${(MEDIA[x.media]?.name || "").replace(/"/g, "")} · ${(b - a).toFixed(1)}초"></span>`; }).join("")}${cur > st + 0.01 && cur < en ? `<i style="left:${((cur - st) / c.dur) * 100}%"></i>` : ""}</div></div>`;
  box.querySelectorAll("[data-c]").forEach((d) => (d.onclick = () => { const x = clipById(d.dataset.c); SM.fromClip = x; sel = x.id; SM.i = x.in; SM.o = x.in + x.dur * (x.speed || 1); smLoad(x.media, x.in, true); smList(); smSentBox(); }));
  const rp = $("#smRep"); if (rp) rp.classList.toggle("hidden", !SM.fromClip);
  if ($("#smNotes")) $("#smNotes").remove();
  if (c.memo) box.insertAdjacentHTML("beforeend", `<div id="smNotes" class="dim" style="font-size:12px">💬 ${c.memo.replace(/</g, "&lt;")}</div>`);
}
function smUpd(light) {
  const m = MEDIA[SM.mid], dur = smV.duration || m?.dur || 1, bar = $("#smBar"); if (!bar) return;
  bar.querySelector(".ph").style.left = (smV.currentTime / dur) * 100 + "%";
  const rg = bar.querySelector(".rng"); if (SM.i != null && m?.kind === "video") { const b = SM.o ?? m.dur; rg.style.display = ""; rg.style.left = (SM.i / dur) * 100 + "%"; rg.style.width = ((b - SM.i) / dur) * 100 + "%"; } else rg.style.display = "none";
  $("#smTc").textContent = m?.kind === "video" ? `${fmt(smV.currentTime)} / ${fmt(m.dur)}` : "사진";
  if (light) return;
  const c = smSent(), r = smRange(); const info = $("#smInfo"); if (!info) return;
  if (!m) { info.textContent = "왼쪽에서 원본을 고르세요."; return; }
  if (m.kind === "image") { info.innerHTML = c ? `사진은 문장 자리(${c.dur.toFixed(1)}초)를 천천히 줌인하며 채워요.` : ""; return; }
  const ln = r.len, need = c ? c.dur : 0;
  let s = `구간 <b>${SM.i != null ? fmt(SM.i) : "(I 안 찍음: 지금 위치)"}</b> → <b>${SM.o != null ? fmt(SM.o) : "(O 안 찍음: 원본 끝)"}</b> = <b style="color:var(--acc)">${ln.toFixed(1)}초</b>`;
  if (c) s += ` · 문장 자리 ${need.toFixed(1)}초 → ` + (ln >= need - 0.05 ? (ln - need > 0.1 ? `채우면 구간 끝 ${(ln - need).toFixed(1)}초는 안 써요` : "딱 맞아요 ✓") : (ln / need >= 0.5 ? `채우면 ${(ln / need).toFixed(2)}배 느리게(슬로) 늘려요` : `너무 짧아요 → "이어 넣기"로 여러 구간을 붙이세요`));
  info.innerHTML = s;
}
function smClip(start, len, extra) {   // 원본 구간을 영상 트랙 [start, start+len]에 넣어요
  const m = MEDIA[SM.mid], img = m.kind === "image";
  cutRange("V1", start, start + len);
  const c = { id: uid(), track: "V1", kind: img ? "image" : "video", media: SM.mid, src: m.rel || m.path, start, in: img ? 0 : smRange().a, dur: len, vol: 0, fit: "cover", zoom: 1, x: 0.5, y: 0.5, speed: 1, ...(extra || {}) };
  if (img) { c.zoomEnd = 1.15; c.xEnd = 0.5; c.yEnd = 0.5; }
  P.clips.push(c); sel = c.id; return c;
}
function smAfter(c, full) {
  dirty(); renderTL(); draw();
  if (full && $("#smNextAuto")?.checked) { const ss = smSents(), k = ss.findIndex((x) => x.id === c.id); if (ss[k + 1]) { smSetSent(ss[k + 1].id); flash(`${c.n || k + 1}번 넣었어요 → 다음 문장`); return; } }
  smSentBox(); smUpd();
}
function smFill() {
  const c = smSent(), r = smRange(); if (!c || !r) return; snap(); SM.fromClip = null;
  const m = MEDIA[SM.mid];
  if (m.kind === "image") smClip(c.start, c.dur);
  else { if (r.len < 0.2) return alert("구간이 너무 짧아요. I·O를 다시 찍어 주세요.");
    const sp = r.len >= c.dur ? 1 : Math.max(0.5, +(r.len / c.dur).toFixed(2)), len = r.len >= c.dur ? c.dur : Math.min(c.dur, r.len / sp);
    smClip(c.start, len, { speed: sp }); SM.cur[c.id] = c.start + len; SM.i = SM.o = null;
    if (len < c.dur - 0.1) { smAfter(c, false); flash(`2배 슬로로도 ${(c.dur - len).toFixed(1)}초 모자라요 → 나머지는 "이어 넣기"로 채우세요`); return; } }
  SM.cur[c.id] = c.start + c.dur; SM.i = SM.o = null; smAfter(c, true);
}
function smAppend() {
  const c = smSent(), r = smRange(); if (!c || !r) return; const en = c.start + c.dur; let cur = SM.cur[c.id] ?? c.start;
  if (cur >= en - 0.1) { if (!confirm("이 문장 자리는 이미 다 찼어요. 처음부터 다시 넣을까요?")) return; cur = c.start; }
  const m = MEDIA[SM.mid], len = Math.min(m.kind === "image" ? 2.5 : r.len, en - cur); if (len < 0.2) return alert("구간이 너무 짧아요.");
  snap(); SM.fromClip = null; smClip(cur, len); SM.cur[c.id] = cur + len; SM.i = SM.o = null;
  smAfter(c, cur + len >= en - 0.1);
}
function smOver() {
  const r = smRange(); if (!r) return; const m = MEDIA[SM.mid], len = m.kind === "image" ? 3 : r.len; if (len < 0.2) return alert("구간이 너무 짧아요.");
  snap(); SM.fromClip = null; smClip(t, len); t += len; placeHead(); SM.i = SM.o = null; dirty(); renderTL(); draw(); smSentBox(); smUpd(); flash("재생선 자리에 넣었어요");
}
function smReplace() {
  const x = SM.fromClip && clipById(SM.fromClip.id), r = smRange(); if (!x || !r) return; const m = MEDIA[SM.mid];
  snap(); x.media = SM.mid; x.src = m.rel || m.path; x.kind = m.kind === "image" ? "image" : "video";
  if (m.kind === "video") { const sp = Math.min(2, Math.max(0.5, +(r.len / x.dur).toFixed(2))); x.in = r.a; x.speed = Math.abs(sp - 1) < 0.04 ? 1 : sp; }
  else { x.in = 0; x.speed = 1; x.zoom = 1; x.zoomEnd = 1.15; }
  delete x.ai; SM.fromClip = null; SM.i = SM.o = null; dirty(); renderTL(); draw(); smSentBox(); smUpd(); flash("그 클립 구간을 바꿨어요(길이·위치 그대로)");
}
addEventListener("keydown", (e) => {
  if (!SM.open || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && e.key !== "Escape") return;
  const k = e.key.toLowerCase(); if (e.ctrlKey || e.metaKey) { if (k === "z") { e.preventDefault(); e.stopImmediatePropagation(); undo(); smSentBox(); } return; }
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.key === "Escape") closeSrcMon();
  else if (e.code === "Space") smPlay();
  else if (k === "i") smMark("i"); else if (k === "o") smMark("o");
  else if (e.key === "ArrowLeft") smSeek(smV.currentTime - (e.shiftKey ? 1 : 1 / 30));
  else if (e.key === "ArrowRight") smSeek(smV.currentTime + (e.shiftKey ? 1 : 1 / 30));
  else if (e.key === "Enter") smFill(); else if (e.key === ",") smAppend(); else if (e.key === ".") smOver();
  else if (e.key === "[" || e.key === "PageUp") smStep(-1); else if (e.key === "]" || e.key === "PageDown") smStep(1);
}, true);
