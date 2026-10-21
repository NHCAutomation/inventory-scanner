"use strict";

// Where "Send Inventory" posts scans. Filled in once the Google Sheets backend is deployed.
const UPLOAD_URL = "";

const CONFIRM_READS = 2;   // identical reads required before an item counts (guards against misreads)
const GONE_MS = 700;       // a code must leave the view this long before the same UPC can count again
const MAX_DECODE_SIDE = 1920;
const STORAGE_KEY = "inventory.v1";
const CAMERA_KEY = "inventory.camera";

const $ = (id) => document.getElementById(id);
const video = $("video"), overlay = $("overlay"), listEl = $("list");

// ---------- Persistent state (survives refresh) ----------

let state = { sessionId: newId(), items: [] }; // items: newest first, {id, upc, ts}
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  if (saved && Array.isArray(saved.items)) state = saved;
} catch {}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { showStatus("Warning: this browser is not saving progress", "error"); }
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------- UPC normalization ----------

// Every read is stored as the 12-digit UPC-A when one exists, so the same product always matches.
// The decoder reports UPC-A and UPC-E codes in 13-digit EAN form with a leading 0.
function toUpc(text) {
  return text.length === 13 && text[0] === "0" ? text.slice(1) : text;
}

// ---------- Item list UI ----------

function renderAll() {
  listEl.replaceChildren(...state.items.map(itemRow));
  renderCounts();
}

function itemRow(item) {
  const li = document.createElement("li");
  li.dataset.id = item.id;
  const code = document.createElement("span");
  code.className = "upc";
  code.textContent = item.upc;
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date(item.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const x = document.createElement("button");
  x.className = "remove";
  x.setAttribute("aria-label", "Remove " + item.upc);
  x.textContent = "✕";
  li.append(code, time, x);
  return li;
}

function renderCounts() {
  const unique = new Set(state.items.map((i) => i.upc)).size;
  $("count").textContent = state.items.length;
  $("unique").textContent = `${unique} unique`;
  $("empty").hidden = state.items.length > 0;
}

listEl.addEventListener("click", (e) => {
  const li = e.target.closest(".remove")?.closest("li");
  if (!li) return;
  state.items = state.items.filter((i) => i.id !== li.dataset.id);
  save();
  li.remove();
  renderCounts();
});

function addItem(upc) {
  const item = { id: newId(), upc, ts: new Date().toISOString() };
  state.items.unshift(item);
  save();
  listEl.prepend(itemRow(item));
  renderCounts();
  $("last").textContent = upc;
  feedback();
}

// ---------- Feedback: beep, buzz, flash ----------

let audioCtx;
function feedback() {
  try {
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.frequency.value = 1800;
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.09);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.09);
  } catch {}
  navigator.vibrate?.(60);
  const v = $("viewport");
  v.classList.remove("flash");
  void v.offsetWidth;
  v.classList.add("flash");
}

function showStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}

// ---------- Camera ----------

let stream, track;

async function openCamera(deviceId) {
  stream?.getTracks().forEach((t) => t.stop());
  const constraints = {
    width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
  };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  } catch (err) {
    if (!deviceId) throw err;
    return openCamera(); // remembered camera is gone; fall back to the default back camera
  }
  track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  await video.play();
  track.addEventListener("ended", () => showStatus("Camera stopped. Tap Resume camera.", "error"));
  await tuneCamera();
}

async function tuneCamera() {
  const caps = track.getCapabilities?.() || {};
  if (caps.focusMode?.includes("continuous")) {
    try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch {}
  }
  const zoom = $("zoom");
  zoom.hidden = !caps.zoom;
  if (caps.zoom) {
    zoom.min = caps.zoom.min;
    zoom.max = Math.min(caps.zoom.max, 8);
    zoom.step = caps.zoom.step || 0.1;
    zoom.value = track.getSettings().zoom ?? caps.zoom.min;
  }
  $("torch").hidden = !caps.torch;
  $("torch").setAttribute("aria-pressed", "false");
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  $("switch").hidden = cams.length < 2;
}

$("zoom").addEventListener("input", (e) => {
  track?.applyConstraints({ advanced: [{ zoom: Number(e.target.value) }] }).catch(() => {});
});

$("torch").addEventListener("click", async (e) => {
  const on = e.currentTarget.getAttribute("aria-pressed") !== "true";
  try {
    await track.applyConstraints({ advanced: [{ torch: on }] });
    e.currentTarget.setAttribute("aria-pressed", String(on));
  } catch {}
});

$("switch").addEventListener("click", async () => {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  const current = track?.getSettings().deviceId;
  const next = cams[(cams.findIndex((c) => c.deviceId === current) + 1) % cams.length];
  try { localStorage.setItem(CAMERA_KEY, next.deviceId); } catch {}
  await openCamera(next.deviceId);
  showStatus(next.label || "Switched camera");
});

$("resume").addEventListener("click", () => {
  openCamera(rememberedCamera()).then(() => showStatus("Camera resumed."), () => showStatus("Camera unavailable.", "error"));
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !started) return;
  if (track?.readyState === "ended") openCamera(rememberedCamera()).catch(() => {});
  if (scanning) requestWakeLock();
});

function rememberedCamera() {
  try { return localStorage.getItem(CAMERA_KEY) || undefined; } catch { return undefined; }
}

// ---------- Decoding loop ----------
// Frames cycle through four passes: each view decoded with each binarizer.
//   "full" view: the whole frame, for close and mid-range codes
//   "zoom" view: the center quarter at up to 2x, so small, distant codes get enough pixels per bar
//   LocalAverage copes with uneven lighting; FixedThreshold recovers blurry and tiny codes.
const PASSES = [["full", "LocalAverage"], ["zoom", "FixedThreshold"], ["full", "FixedThreshold"], ["zoom", "LocalAverage"]];

const worker = new Worker("decoder-worker.js");
const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
let workerReady = false, busy = false, passIndex = 0, inFlight;

worker.onmessage = ({ data }) => {
  if (data.type === "ready") { workerReady = true; return; }
  if (data.type === "error") { showStatus("Scanner engine failed to load: " + data.message, "error"); return; }
  busy = false;
  if (scanning) handleCodes(data.codes, inFlight);
};

function pump() {
  requestAnimationFrame(pump);
  if (!scanning || busy || !workerReady || video.readyState < 2) return;
  const vw = video.videoWidth, vh = video.videoHeight;
  const [view, binarizer] = PASSES[passIndex];
  passIndex = (passIndex + 1) % PASSES.length;

  // Only decode what's visible on screen (the video is cropped by object-fit: cover),
  // so nothing outside the viewfinder can ever be counted.
  const k = Math.max(overlay.clientWidth / vw, overlay.clientHeight / vh);
  let sw = overlay.clientWidth / k, sh = overlay.clientHeight / k;
  let sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  if (view === "zoom") { sx += sw / 4; sy += sh / 4; sw /= 2; sh /= 2; }
  const scale = Math.min(view === "zoom" ? 2 : 1, MAX_DECODE_SIDE / Math.max(sw, sh));
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  inFlight = { sx, sy, scale };
  busy = true;
  worker.postMessage({ binarizer, buffer: img.data.buffer, width: img.width, height: img.height }, [img.data.buffer]);
}

// ---------- Counting ----------
// Each UPC in view is tracked. It counts once after CONFIRM_READS identical reads,
// and can only count again after it has been out of view for GONE_MS.

const tracks = new Map(); // upc -> { hits, lastSeen, counted }

function handleCodes(codes, info) {
  const now = performance.now();
  const seen = new Set();
  const boxes = [];
  for (const c of codes) {
    const upc = toUpc(c.text);
    if (!/^\d{8,13}$/.test(upc) || seen.has(upc)) continue;
    seen.add(upc);
    let t = tracks.get(upc);
    if (!t) tracks.set(upc, (t = { hits: 0, lastSeen: now, counted: false }));
    t.hits++;
    t.lastSeen = now;
    if (!t.counted && t.hits >= CONFIRM_READS) {
      t.counted = true;
      addItem(upc);
    }
    boxes.push({ pos: c.position, info, counted: t.counted });
  }
  for (const [upc, t] of tracks) if (now - t.lastSeen > GONE_MS) tracks.delete(upc);
  drawBoxes(boxes);
}

function drawBoxes(boxes) {
  const w = overlay.clientWidth, h = overlay.clientHeight, dpr = devicePixelRatio || 1;
  if (overlay.width !== w * dpr) { overlay.width = w * dpr; overlay.height = h * dpr; }
  const o = overlay.getContext("2d");
  o.setTransform(dpr, 0, 0, dpr, 0, 0);
  o.clearRect(0, 0, w, h);
  // The video is shown with object-fit: cover, so map video pixels to screen pixels the same way.
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.max(w / vw, h / vh), ox = (w - vw * k) / 2, oy = (h - vh * k) / 2;
  o.lineWidth = 4;
  for (const { pos, info, counted } of boxes) {
    o.strokeStyle = counted ? "#3ddc84" : "#ffd23f";
    o.beginPath();
    for (const p of [pos.topLeft, pos.topRight, pos.bottomRight, pos.bottomLeft]) {
      o.lineTo(ox + (info.sx + p.x / info.scale) * k, oy + (info.sy + p.y / info.scale) * k);
    }
    o.closePath();
    o.stroke();
  }
}

// ---------- Inventory controls ----------

let started = false, scanning = false, wakeLock;

async function begin() {
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume?.();
  try {
    await openCamera(rememberedCamera());
  } catch (err) {
    $("intro-error").textContent = "Camera unavailable: allow camera access for this site and reload.";
    return;
  }
  started = true;
  $("intro").hidden = true;
  $("app").hidden = false;
  startVoice();
  requestAnimationFrame(pump);
  showStatus('Say "Start inventory" or tap Start.');
}

function startInventory() {
  if (!started || scanning) return;
  scanning = true;
  tracks.clear();
  $("toggle").textContent = "Stop";
  $("toggle").classList.add("on");
  $("viewport").classList.add("live");
  requestWakeLock();
  showStatus("Scanning. Each item counts once; move it out of view before the next one.");
}

function stopInventory() {
  if (!scanning) return;
  scanning = false;
  $("toggle").textContent = "Start";
  $("toggle").classList.remove("on");
  $("viewport").classList.remove("live");
  drawBoxes([]);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  showStatus("Paused. Say \"Start inventory\" to continue or \"Send inventory\" to upload.");
}

async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
}

let sending = false;
async function sendInventory() {
  if (sending) return;
  if (!state.items.length) return showStatus("Nothing to send yet.");
  if (!UPLOAD_URL) return showStatus("Google Sheets is not connected yet. Your scans are saved on this phone.", "error");
  stopInventory();
  sending = true;
  $("send").disabled = true;
  const batch = state.items.slice();
  showStatus(`Sending ${batch.length} items…`);
  try {
    // text/plain avoids a CORS preflight, which Google Apps Script does not answer.
    const res = await fetch(UPLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ sessionId: state.sessionId, items: batch.slice().reverse() }),
    });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.error || "HTTP " + res.status);
    const sent = new Set(batch.map((i) => i.id));
    state.items = state.items.filter((i) => !sent.has(i.id));
    state.sessionId = newId();
    save();
    renderAll();
    $("last").textContent = "";
    showStatus(`Sent ${batch.length} items to Google Sheets.`, "ok");
  } catch (err) {
    showStatus(`Send failed (${err.message}). Nothing was lost; try again.`, "error");
  } finally {
    sending = false;
    $("send").disabled = false;
  }
}

$("begin").addEventListener("click", begin);
$("toggle").addEventListener("click", () => (scanning ? stopInventory() : startInventory()));
$("send").addEventListener("click", sendInventory);

// ---------- Voice commands ----------

const COMMANDS = [
  [/\bstart (the )?invent/, startInventory],
  [/\b(stop|pause) (the )?invent/, stopInventory],
  [/\bsend (the )?invent/, sendInventory],
];
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer, lastCommandAt = 0;

function startVoice() {
  if (!SpeechRecognition) {
    $("voice").textContent = "Voice not supported in this browser; use the buttons.";
    return;
  }
  recognizer = new SpeechRecognition();
  recognizer.continuous = true;
  recognizer.interimResults = true; // act on a phrase as soon as it's recognized, not after a pause
  recognizer.lang = "en-US";
  const handled = new Set();
  let run = 0;
  recognizer.onstart = () => { run++; $("voice").textContent = "🎙 Listening"; };
  recognizer.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const heard = e.results[i][0].transcript.toLowerCase();
      for (const [pattern, action] of COMMANDS) {
        const key = `${run}:${i}:${pattern}`;
        if (!pattern.test(heard) || handled.has(key)) continue;
        handled.add(key);
        if (performance.now() - lastCommandAt < 1500) continue; // one phrase, one action
        lastCommandAt = performance.now();
        $("voice").textContent = `🎙 "${heard.trim()}"`;
        action();
      }
    }
  };
  recognizer.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      recognizer = null;
      $("voice").textContent = "Microphone blocked; use the buttons.";
    }
  };
  // Browsers end recognition after silence; keep listening for the whole session.
  recognizer.onend = () => setTimeout(() => { try { recognizer?.start(); } catch {} }, 250);
  try { recognizer.start(); } catch {}
}

renderAll();
