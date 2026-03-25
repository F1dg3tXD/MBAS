import { createNanoEvents } from "nanoevents";

const STEPS = 16;
const PITCH_ROWS = ["C5", "B4", "A4", "G4", "F4", "E4", "D4", "C4"];
const STEP_WIDTH = 20; // px, must match CSS --step-width
const ROW_HEIGHT = 22; // px, must match CSS --row-height

// Allowed Moonbase Alpha / DekTalk phonemes (reconstructed common set)
const ALLOWED_PHONEMES = new Set([
  // Core vowels
  "IY", "IH", "EH", "AE", "AA", "AH", "AO", "UH", "UW",
  "ER", "AX", "EY", "AY", "OW", "AW", "OY",
  // Stops & basic consonants
  "P", "B", "T", "D", "K", "G",
  // Fricatives
  "F", "V", "TH", "DH", "S", "Z", "SH", "ZH", "HH",
  // Nasals
  "M", "N", "NG",
  // Liquids & glides
  "L", "R", "W", "Y",
  // Affricates
  "CH", "JH",
  // Special / utility
  "Q", "DX", "EL", "EM", "EN", "NX", "WH"
]);

function sanitizePhonemeToken(token) {
  if (!token) return null;
  // Keep only A–Z letters, uppercase, and check against allowed set
  const cleaned = token.toUpperCase().replace(/[^A-Z]/g, "");
  if (!cleaned) return null;
  return ALLOWED_PHONEMES.has(cleaned) ? cleaned : null;
}

const bus = createNanoEvents();

const state = {
  bpm: 110,
  playing: false,
  playStep: 0,
  notes: [],
  maxLen: 120,
  linePrefix: "",
  literalSymbols: true,
  chaosMode: false,
  strictCap: true,
  timezoneGuard: true,
  previewEnabled: false,
  timerId: null,
  nextNoteId: 1
};

const SYMBOL_WORDS = {
  "*": "asterisk",
  "?": "question mark",
  "!": "exclamation mark",
  "#": "hash",
  "@": "at sign",
  "&": "ampersand"
};

/* DOM helpers */

const $ = (sel) => document.querySelector(sel);

function createEl(tag, className, attrs = {}) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") el.textContent = v;
    else el.setAttribute(k, v);
  }
  return el;
}

/* Piano roll rendering */

function renderPitchLabels() {
  const wrap = $("#pitch-labels");
  wrap.innerHTML = "";
  PITCH_ROWS.forEach((label) => {
    const el = createEl("div", "pitch-label", { text: label });
    wrap.appendChild(el);
  });
}

function renderNotes() {
  const grid = $("#roll-grid");
  // Remove all existing notes but keep playhead
  const existingNotes = grid.querySelectorAll(".note");
  existingNotes.forEach((n) => n.remove());

  state.notes.forEach((note) => {
    const el = createEl("div", "note");
    el.dataset.id = String(note.id);
    const label = createEl("span", "note-label", { text: note.token });
    const resizer = createEl("div", "note-resize");
    el.append(label, resizer);

    positionNoteElement(el, note);
    attachNoteInteractions(el, note);

    grid.appendChild(el);
  });
}

function positionNoteElement(el, note) {
  const top = (PITCH_ROWS.length - 1 - note.row) * ROW_HEIGHT + 2;
  const left = note.start * STEP_WIDTH;
  const width = Math.max(1, note.length) * STEP_WIDTH - 2;

  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
  el.style.width = `${width}px`;
}

/* Note interactions */

function attachNoteInteractions(el, note) {
  const resizer = el.querySelector(".note-resize");
  let mode = null; // "move" | "resize"
  let startX = 0;
  let startY = 0;
  let startStep = 0;
  let startRow = 0;
  let startLen = 0;

  const onPointerDownMove = (e) => {
    e.preventDefault();
    mode = "move";
    startPointer(e);
  };

  const onPointerDownResize = (e) => {
    e.preventDefault();
    e.stopPropagation();
    mode = "resize";
    startPointer(e);
  };

  function startPointer(e) {
    el.classList.add("dragging");
    startX = e.clientX;
    startY = e.clientY;
    startStep = note.start;
    startRow = note.row;
    startLen = note.length;

    const move = (ev) => onPointerMove(ev);
    const up = () => onPointerUp(move);

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }

  function onPointerMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (mode === "move") {
      const stepDelta = Math.round(dx / STEP_WIDTH);
      const rowDelta = Math.round(dy / ROW_HEIGHT) * -1;

      let newStart = startStep + stepDelta;
      newStart = Math.max(0, Math.min(STEPS - 1, newStart));

      let newRow = startRow + rowDelta;
      newRow = Math.max(0, Math.min(PITCH_ROWS.length - 1, newRow));

      note.start = newStart;
      note.row = newRow;
    } else if (mode === "resize") {
      const stepDelta = Math.round(dx / STEP_WIDTH);
      let newLen = Math.max(1, startLen + stepDelta);
      if (note.start + newLen > STEPS) {
        newLen = STEPS - note.start;
      }
      note.length = newLen;
    }

    positionNoteElement(el, note);
  }

  function onPointerUp(move) {
    window.removeEventListener("pointermove", move);
    el.classList.remove("dragging");
  }

  el.addEventListener("pointerdown", onPointerDownMove);
  resizer.addEventListener("pointerdown", onPointerDownResize);
}

/* Sequencing & TTS */

function stepIntervalMs() {
  const beatsPerSec = state.bpm / 60;
  const stepsPerBeat = 2; // 16 steps per 4/4 bar
  return 1000 / (beatsPerSec * stepsPerBeat);
}

function updatePlayhead() {
  const playhead = $("#playhead");
  const left = state.playStep * STEP_WIDTH;
  playhead.style.left = `${left}px`;
}

function nextStep() {
  state.playStep = (state.playStep + 1) % STEPS;
  updatePlayhead();

  const nowStep = state.playStep;
  const activeNotes = state.notes.filter(
    (n) => nowStep >= n.start && nowStep < n.start + n.length
  );
  if (!activeNotes.length) return;

  const line = buildDekLineForNotes(activeNotes);
  if (!line) return;

  if (state.previewEnabled && "speechSynthesis" in window) {
    const utter = new SpeechSynthesisUtterance(stripDekCodesForTTS(line));
    utter.rate = 1.15;
    utter.pitch = 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }
}

function buildDekLineForNotes(notes) {
  // Map each note to a validated phoneme: [PHONEME<dur,pitch>]
  const fragments = [];

  notes.forEach((n) => {
    const phoneme = sanitizePhonemeToken(n.token);
    if (!phoneme) return; // skip tokens that are not valid phonemes

    const dur = 100 + n.length * 20; // rough duration
    const pitch = 20 + n.row * 10; // simple pitch scale
    fragments.push(`[${phoneme}<${dur},${pitch}>]`);
  });

  return fragments.join(" ");
}

function stripDekCodesForTTS(text) {
  let cleaned = text
    .replace(/\[:[^\]]+\]/g, " ")
    .replace(/\[[^<\]]+<[0-9,\-]+>\]/g, " ")
    .replace(/\s+/g, " ");

  if (state.literalSymbols) {
    cleaned = [...cleaned].map((char) => SYMBOL_WORDS[char] ?? char).join("");
  }
  return cleaned.trim();
}

function startPlayback() {
  if (state.playing) return;
  if (!state.notes.length) return;
  state.playing = true;
  $("#play-toggle").textContent = "Pause";
  state.playStep = -1;
  nextStep();
  state.timerId = setInterval(nextStep, stepIntervalMs());
}

function stopPlayback() {
  if (!state.playing) return;
  state.playing = false;
  $("#play-toggle").textContent = "Play";
  clearInterval(state.timerId);
  state.timerId = null;
}

/* Text -> notes */

function splitTextToNotes() {
  const text = $("#source-text").value.trim();
  state.notes = [];
  if (!text) {
    renderNotes();
    return;
  }

  // Very simple "phoneme" tokenization: split by whitespace
  const tokens = text.split(/\s+/).filter(Boolean);
  let step = 0;
  const defaultRow = Math.floor(PITCH_ROWS.length / 2);

  tokens.forEach((token) => {
    if (step >= STEPS) return;
    const cleaned = sanitizePhonemeToken(token) || token;
    const note = {
      id: state.nextNoteId++,
      token: cleaned,
      start: step,
      length: 1,
      row: defaultRow
    };
    state.notes.push(note);
    step += 1;
  });

  renderNotes();
  updateDiagnostics();
}

/* Export */

function generateLines() {
  const maxLen = Math.max(32, Math.min(128, Number($("#max-len").value) || 120));
  state.maxLen = maxLen;
  $("#max-len").value = String(maxLen);
  state.linePrefix = $("#line-prefix").value || "";

  const perStepLines = [];

  for (let step = 0; step < STEPS; step++) {
    const notes = state.notes.filter(
      (n) => step >= n.start && step < n.start + n.length
    );
    if (!notes.length) continue;
    let line = buildDekLineForNotes(notes);
    line = applyMoonbaseJank(line);
    if (state.timezoneGuard) {
      line = line.replace(/EST PST CST MST EST PST CST MST/gi, "[BLOCKED_TZ_SEQUENCE]");
    }
    if (line.trim()) perStepLines.push(line);
  }

  const outputLines = [];
  let overLimit = false;

  perStepLines.forEach((line) => {
    let current = state.linePrefix + line;
    while (current.length > 0) {
      const lenLimit = state.strictCap ? Math.min(maxLen, 128) : maxLen;
      if (current.length <= lenLimit) {
        outputLines.push(current);
        current = "";
      } else {
        overLimit = true;
        outputLines.push(current.slice(0, lenLimit));
        current = current.slice(lenLimit);
      }
    }
  });

  $("#export-output").value = outputLines.join("\n");
  const warning = $("#char-warning");
  if (overLimit || outputLines.some((l) => l.length > 128)) {
    warning.classList.remove("hidden");
  } else {
    warning.classList.add("hidden");
  }
  updateDiagnostics();
}

function applyMoonbaseJank(line) {
  if (!state.chaosMode || !line) return line;
  return line
    .split("")
    .map((char, idx) => {
      if (/[a-z]/i.test(char) && idx % 3 === 0) {
        return Math.random() > 0.5 ? char.toUpperCase() : char.toLowerCase();
      }
      if (char === " " && Math.random() > 0.75) {
        return "  ";
      }
      return char;
    })
    .join("");
}

function updateDiagnostics() {
  const source = $("#source-text").value || "";
  $("#char-meter").textContent = `${source.length} / 128`;

  const riskyTimezone = /EST PST CST MST EST PST CST MST/i.test(source);
  $("#tz-warning").classList.toggle("hidden", !riskyTimezone);

  const tokens = source.split(/\s+/).filter(Boolean);
  const invalidPhonemes = tokens.filter(
    (token) => token.startsWith("[") ? false : !sanitizePhonemeToken(token) && !token.startsWith("[:")
  );
  $("#phoneme-warning").classList.toggle("hidden", invalidPhonemes.length === 0);
}

/* Tabs */

function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const id = tab.dataset.tab;
      document.querySelectorAll(".tab-content").forEach((c) => {
        c.classList.toggle("active", c.id === `tab-${id}`);
      });
    });
  });
}

/* Controls */

function bindControls() {
  const bpmInput = $("#tempo");
  const bpmVal = $("#tempo-value");
  bpmVal.textContent = String(state.bpm);
  bpmInput.value = String(state.bpm);
  bpmInput.addEventListener("input", () => {
    state.bpm = Number(bpmInput.value) || 110;
    bpmVal.textContent = String(state.bpm);
    if (state.playing) {
      clearInterval(state.timerId);
      state.timerId = setInterval(nextStep, stepIntervalMs());
    }
  });

  $("#play-toggle").addEventListener("click", () => {
    if (state.playing) stopPlayback();
    else startPlayback();
  });

  $("#stop").addEventListener("click", () => {
    stopPlayback();
  });

  $("#split-notes").addEventListener("click", () => {
    splitTextToNotes();
  });

  $("#generate").addEventListener("click", () => {
    generateLines();
  });

  $("#copy-output").addEventListener("click", async () => {
    const text = $("#export-output").value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  });

  $("#literal-symbols").addEventListener("change", (e) => {
    state.literalSymbols = e.target.checked;
  });

  $("#chaos-mode").addEventListener("change", (e) => {
    state.chaosMode = e.target.checked;
  });

  $("#strict-cap").addEventListener("change", (e) => {
    state.strictCap = e.target.checked;
  });

  $("#timezone-guard").addEventListener("change", (e) => {
    state.timezoneGuard = e.target.checked;
  });

  $("#preview-toggle").addEventListener("change", (e) => {
    state.previewEnabled = e.target.checked;
    if (!state.previewEnabled && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  });

  $("#source-text").addEventListener("input", updateDiagnostics);
}

/* Init */

function init() {
  renderPitchLabels();
  renderNotes();
  setupTabs();
  bindControls();
  updateDiagnostics();
}

document.addEventListener("DOMContentLoaded", init);
