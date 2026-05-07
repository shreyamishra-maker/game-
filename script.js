/* ═══════════════════════════════════════════════════════
   NEON DRIFT — script.js
   Full game engine: canvas rendering, physics, audio,
   input handling, collision detection, HUD, menus.
═══════════════════════════════════════════════════════ */

"use strict";

// ─────────────────────────────────────────────────────
// 1. GLOBAL CONFIG  (easy to customise)
// ─────────────────────────────────────────────────────
const CFG = {
  // Road
  laneCount:        4,
  laneLineHeight:   60,
  laneLineGap:      40,
  roadWidthRatio:   0.7,   // fraction of canvas width

  // Player car dimensions
  playerW:          52,
  playerH:          90,

  // Starting game speed (px/frame at 60 fps)
  baseSpeed:        5,
  // Speed added per 500 score points
  speedIncrement:   0.4,
  maxSpeed:         22,

  // Score per frame of survival
  scorePerFrame:    0.08,

  // Traffic car dimensions
  trafficW:         52,
  trafficH:         85,
  // How many traffic cars on screen at once
  maxTraffic:       6,

  // Nitro
  nitroDuration:    180,   // frames
  nitroRecharge:    240,   // frames to fully recharge
  nitroMultiplier:  2.2,

  // Stars / particles (night mode)
  starCount:        80,

  // Available player colours
  carColors: {
    cyan:    "#00f5ff",
    magenta: "#ff00cc",
    lime:    "#39ff14",
    orange:  "#ff6600",
    gold:    "#ffd700",
  },

  // Traffic car colours
  trafficColors: ["#e63946","#f4a261","#2a9d8f","#457b9d","#e9c46a","#8338ec"],
};

// ─────────────────────────────────────────────────────
// 2. GAME STATE
// ─────────────────────────────────────────────────────
const STATE = {
  phase: "menu",          // "menu" | "playing" | "paused" | "over"
  score:     0,
  highScore: 0,
  speed:     CFG.baseSpeed,
  nitro:     CFG.nitroDuration,
  nitroActive: false,
  nitroCooldown: 0,
  playerColor: "#00f5ff",
  nightMode:  true,
  musicOn:    true,
  frameId:    null,
};

// ─────────────────────────────────────────────────────
// 3. CANVAS SETUP
// ─────────────────────────────────────────────────────
const canvas = document.getElementById("gameCanvas");
const ctx    = canvas.getContext("2d");

let W = 0, H = 0, roadLeft = 0, roadRight = 0, roadW = 0, laneW = 0;

function resize() {
  W = canvas.width  = window.innerWidth;
  H = canvas.height = window.innerHeight;
  roadW     = Math.min(W * CFG.roadWidthRatio, 360);
  roadLeft  = (W - roadW) / 2;
  roadRight = roadLeft + roadW;
  laneW     = roadW / CFG.laneCount;
  if (player) {
    // Keep player within road after resize
    player.x = Math.max(roadLeft + player.w / 2,
                Math.min(roadRight - player.w / 2, player.x));
  }
}

window.addEventListener("resize", resize);
resize();

// ─────────────────────────────────────────────────────
// 4. AUDIO ENGINE  (Web Audio API — no external files)
// ─────────────────────────────────────────────────────
let audioCtx = null;
let engineNode = null, engineGain = null;
let bgOscillators = [];
let bgGain = null;

function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

/* Engine hum — low sawtooth whose pitch rises with speed */
function startEngine() {
  if (!audioCtx) return;
  if (engineNode) return;
  engineGain          = audioCtx.createGain();
  engineGain.gain.value = 0.07;
  engineGain.connect(audioCtx.destination);

  engineNode = audioCtx.createOscillator();
  engineNode.type = "sawtooth";
  engineNode.frequency.value = 90;
  engineNode.connect(engineGain);
  engineNode.start();
}

function updateEngineSound(speed) {
  if (!engineNode) return;
  const freq = 80 + (speed / CFG.maxSpeed) * 160;
  engineNode.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.1);
  engineGain.gain.setTargetAtTime(STATE.nitroActive ? 0.12 : 0.06, audioCtx.currentTime, 0.1);
}

function stopEngine() {
  if (!engineNode) return;
  try { engineNode.stop(); } catch(_) {}
  engineNode = null;
}

/* Crash sound — short burst of filtered noise */
function playCrash() {
  if (!audioCtx) return;
  const dur    = 0.8;
  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
  const data   = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;

  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(800, audioCtx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(80, audioCtx.currentTime + dur);

  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.6, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);

  source.connect(filter).connect(g).connect(audioCtx.destination);
  source.start();
}

/* Nitro whoosh */
function playNitroSound() {
  if (!audioCtx) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(300, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(800, audioCtx.currentTime + 0.15);
  gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.3);
}

/* Background music — three oscillators making a simple pulsing pad */
function startBGMusic() {
  if (!STATE.musicOn || bgOscillators.length) return;
  if (!audioCtx) return;

  bgGain = audioCtx.createGain();
  bgGain.gain.value = 0.04;
  bgGain.connect(audioCtx.destination);

  const notes = [110, 138.6, 165];
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = audioCtx.createGain();
    // Pulse each note at a slightly different rate for "breathing" effect
    const lfo = audioCtx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.4 + i * 0.07;
    const lfoGain = audioCtx.createGain();
    lfoGain.gain.value = 0.5;
    lfo.connect(lfoGain).connect(g.gain);
    g.gain.value = 0.6;
    lfo.start();
    osc.connect(g).connect(bgGain);
    osc.start();
    bgOscillators.push(osc, lfo);
  });
}

function stopBGMusic() {
  bgOscillators.forEach(o => { try { o.stop(); } catch(_) {} });
  bgOscillators = [];
  if (bgGain) { bgGain.disconnect(); bgGain = null; }
}

// ─────────────────────────────────────────────────────
// 5. INPUT HANDLER
// ─────────────────────────────────────────────────────
const keys = {};
window.addEventListener("keydown", e => {
  keys[e.code] = true;
  if ((e.code === "KeyP" || e.code === "Escape") && STATE.phase === "playing") togglePause();
  if ((e.code === "KeyP" || e.code === "Escape") && STATE.phase === "paused")  togglePause();
});
window.addEventListener("keyup", e => { keys[e.code] = false; });

// Touch controls (mobile) — injected dynamically
let touchLeft = false, touchRight = false, touchNitro = false;

function injectTouchControls() {
  if (document.getElementById("touchControls")) return;
  const el = document.createElement("div");
  el.id = "touchControls";
  el.innerHTML = `
    <div class="touch-dpad">
      <div class="touch-btn" id="tLeft">◀</div>
      <div class="touch-btn" id="tRight">▶</div>
    </div>
    <div class="touch-nitro" id="tNitro">⚡<br/>NITRO</div>
  `;
  document.body.appendChild(el);

  const addTouch = (id, setter) => {
    const el = document.getElementById(id);
    el.addEventListener("touchstart", e => { e.preventDefault(); setter(true);  }, {passive:false});
    el.addEventListener("touchend",   e => { e.preventDefault(); setter(false); }, {passive:false});
    el.addEventListener("mousedown",  () => setter(true));
    el.addEventListener("mouseup",    () => setter(false));
  };
  addTouch("tLeft",  v => touchLeft  = v);
  addTouch("tRight", v => touchRight = v);
  addTouch("tNitro", v => touchNitro = v);
}

// ─────────────────────────────────────────────────────
// 6. PLAYER CAR
// ─────────────────────────────────────────────────────
const player = {
  x: 0, y: 0,
  w: CFG.playerW,
  h: CFG.playerH,
  speed: 5,         // lateral speed
  tilt:  0,         // visual tilt when turning
};

function resetPlayer() {
  player.x = W / 2;
  player.y = H - 160;
  player.tilt = 0;
}

// ─────────────────────────────────────────────────────
// 7. ROAD LANE-LINES (scrolling dashes)
// ─────────────────────────────────────────────────────
const laneLines = [];
const SEGMENT = CFG.laneLineHeight + CFG.laneLineGap;

function initLaneLines() {
  laneLines.length = 0;
  // For each internal lane divider
  for (let lane = 1; lane < CFG.laneCount; lane++) {
    const x = roadLeft + lane * laneW;
    let y = 0;
    while (y < H + SEGMENT) {
      laneLines.push({ x, y, lane });
      y += SEGMENT;
    }
  }
}

function updateLaneLines(speed) {
  laneLines.forEach(l => {
    l.y += speed;
    if (l.y > H + SEGMENT) l.y -= (H + SEGMENT * 2);
  });
}

// ─────────────────────────────────────────────────────
// 8. TRAFFIC CARS
// ─────────────────────────────────────────────────────
const traffic = [];

function spawnTrafficCar() {
  // Pick a random lane
  const lane = Math.floor(Math.random() * CFG.laneCount);
  const x    = roadLeft + lane * laneW + laneW / 2;

  // Avoid spawning on top of existing cars
  const tooClose = traffic.some(t => Math.abs(t.x - x) < laneW && t.y < 160);
  if (tooClose) return;

  const color = CFG.trafficColors[Math.floor(Math.random() * CFG.trafficColors.length)];
  // Speed relative to game speed; slower than player creates "passing" effect
  const relSpeed = STATE.speed * (0.3 + Math.random() * 0.4);

  traffic.push({
    x, y: -CFG.trafficH - 20,
    w: CFG.trafficW,
    h: CFG.trafficH,
    color,
    relSpeed, // how fast they move relative to road
  });
}

function updateTraffic() {
  // Spawn if under limit
  if (traffic.length < CFG.maxTraffic && Math.random() < 0.018) spawnTrafficCar();

  for (let i = traffic.length - 1; i >= 0; i--) {
    const t = traffic[i];
    // Cars move down at speed – their own relative speed (so faster game = cars passed quickly)
    t.y += STATE.speed - t.relSpeed;
    if (t.y > H + 200) traffic.splice(i, 1);
  }
}

// ─────────────────────────────────────────────────────
// 9. STARS / ENVIRONMENT PARTICLES (night mode)
// ─────────────────────────────────────────────────────
const stars = [];

function initStars() {
  stars.length = 0;
  for (let i = 0; i < CFG.starCount; i++) {
    stars.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.5 + 0.3,
      alpha: Math.random() * 0.8 + 0.2,
      twinkleSpeed: Math.random() * 0.02 + 0.005,
      twinkleOffset: Math.random() * Math.PI * 2,
    });
  }
}

// Roadside lamp posts (scrolling)
const lamps = [];
function initLamps() {
  lamps.length = 0;
  const spacing = 120;
  for (let y = 0; y < H + spacing; y += spacing) {
    lamps.push({ y, offset: y });
  }
}

function updateLamps(speed) {
  lamps.forEach(l => {
    l.y += speed * 0.6;
    if (l.y > H + 40) l.y -= (H + 80);
  });
}

// ─────────────────────────────────────────────────────
// 10. NITRO PARTICLES
// ─────────────────────────────────────────────────────
const nitroParticles = [];

function spawnNitroParticles() {
  for (let i = 0; i < 3; i++) {
    nitroParticles.push({
      x: player.x + (Math.random() - 0.5) * 20,
      y: player.y + player.h / 2 - 5,
      vx: (Math.random() - 0.5) * 3,
      vy: Math.random() * 5 + 3,
      life: 1,
      size: Math.random() * 8 + 4,
      color: Math.random() < 0.5 ? "#00f5ff" : "#ff00cc",
    });
  }
}

function updateNitroParticles() {
  for (let i = nitroParticles.length - 1; i >= 0; i--) {
    const p = nitroParticles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= 0.045;
    if (p.life <= 0) nitroParticles.splice(i, 1);
  }
}

// ─────────────────────────────────────────────────────
// 11. COLLISION DETECTION
// ─────────────────────────────────────────────────────
function checkCollision() {
  const margin = 8; // forgiveness margin
  const px = player.x - player.w / 2 + margin;
  const py = player.y - player.h / 2 + margin;
  const pw = player.w - margin * 2;
  const ph = player.h - margin * 2;

  for (const t of traffic) {
    const tx = t.x - t.w / 2 + margin;
    const ty = t.y - t.h / 2 + margin;
    if (px < tx + t.w - margin * 2 &&
        px + pw > tx &&
        py < ty + t.h - margin * 2 &&
        py + ph > ty) {
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────
// 12. DRAWING HELPERS
// ─────────────────────────────────────────────────────

/* Draw road with a perspective-ish gradient */
function drawRoad() {
  // Sky / background
  if (STATE.nightMode) {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#03030d");
    sky.addColorStop(1, "#060616");
    ctx.fillStyle = sky;
  } else {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#87ceeb");
    sky.addColorStop(0.6, "#e8c86d");
    sky.addColorStop(1, "#c2a45e");
    ctx.fillStyle = sky;
  }
  ctx.fillRect(0, 0, W, H);

  // Stars (night only)
  if (STATE.nightMode) {
    const t = performance.now() / 1000;
    stars.forEach(s => {
      const alpha = s.alpha * (0.6 + 0.4 * Math.sin(t * s.twinkleSpeed * 10 + s.twinkleOffset));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fill();
    });
  }

  // Roadside scenery
  drawRoadSides();

  // Road surface
  const roadGrad = ctx.createLinearGradient(roadLeft, 0, roadRight, 0);
  if (STATE.nightMode) {
    roadGrad.addColorStop(0,   "#0b0b1a");
    roadGrad.addColorStop(0.5, "#111125");
    roadGrad.addColorStop(1,   "#0b0b1a");
  } else {
    roadGrad.addColorStop(0,   "#3a3a3a");
    roadGrad.addColorStop(0.5, "#4a4a4a");
    roadGrad.addColorStop(1,   "#3a3a3a");
  }
  ctx.fillStyle = roadGrad;
  ctx.fillRect(roadLeft, 0, roadW, H);

  // Edge glow strips
  const edgeGlow = ctx.createLinearGradient(roadLeft, 0, roadLeft + 8, 0);
  edgeGlow.addColorStop(0, "rgba(0,245,255,0.35)");
  edgeGlow.addColorStop(1, "transparent");
  ctx.fillStyle = edgeGlow;
  ctx.fillRect(roadLeft - 1, 0, 9, H);

  const edgeGlowR = ctx.createLinearGradient(roadRight - 8, 0, roadRight, 0);
  edgeGlowR.addColorStop(0, "transparent");
  edgeGlowR.addColorStop(1, "rgba(0,245,255,0.35)");
  ctx.fillStyle = edgeGlowR;
  ctx.fillRect(roadRight - 8, 0, 9, H);

  // Road edge lines
  ctx.strokeStyle = STATE.nightMode ? "rgba(0,245,255,0.7)" : "rgba(255,255,255,0.8)";
  ctx.lineWidth = 3;
  ctx.shadowBlur = STATE.nightMode ? 12 : 0;
  ctx.shadowColor = "#00f5ff";
  ctx.beginPath(); ctx.moveTo(roadLeft,  0); ctx.lineTo(roadLeft,  H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(roadRight, 0); ctx.lineTo(roadRight, H); ctx.stroke();
  ctx.shadowBlur = 0;
}

/* Scrolling lane-line dashes */
function drawLaneLines() {
  laneLines.forEach(l => {
    ctx.fillStyle = STATE.nightMode ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.55)";
    ctx.fillRect(l.x - 2, l.y, 4, CFG.laneLineHeight);
  });
}

/* Roadside scenery: lamp posts and distant buildings */
function drawRoadSides() {
  const t = performance.now() / 1000;

  // Left / right side fill
  if (!STATE.nightMode) {
    ctx.fillStyle = "#5a8a3c";
    ctx.fillRect(0, H * 0.35, roadLeft, H);
    ctx.fillRect(roadRight, H * 0.35, W - roadRight, H);
  }

  // Lamp posts
  lamps.forEach((l, i) => {
    const side = i % 2 === 0 ? roadLeft - 22 : roadRight + 22;
    drawLampPost(side, l.y, t);
  });
}

function drawLampPost(x, y, t) {
  if (!STATE.nightMode) return;
  // Post
  ctx.strokeStyle = "#334";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 70); ctx.stroke();
  // Arm
  ctx.beginPath(); ctx.moveTo(x, y - 70); ctx.lineTo(x + (x < W/2 ? 18 : -18), y - 70); ctx.stroke();
  // Light glow
  const gx = x + (x < W/2 ? 18 : -18);
  const gy = y - 70;
  const pulse = 0.75 + 0.25 * Math.sin(t * 1.3);
  const lg = ctx.createRadialGradient(gx, gy, 0, gx, gy, 40);
  lg.addColorStop(0, `rgba(255,220,80,${0.6 * pulse})`);
  lg.addColorStop(1, "transparent");
  ctx.fillStyle = lg;
  ctx.fillRect(gx - 40, gy - 40, 80, 80);

  ctx.beginPath(); ctx.arc(gx, gy, 4, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,240,180,${0.9 * pulse})`;
  ctx.fill();
}

/* Draw a stylised car (player or traffic) */
function drawCar(x, y, w, h, color, isPlayer, tilt = 0) {
  ctx.save();
  ctx.translate(x, y);
  if (tilt) ctx.rotate(tilt * 0.08);

  const hw = w / 2, hh = h / 2;

  // Body shadow / glow
  if (STATE.nightMode) {
    ctx.shadowBlur  = isPlayer ? 24 : 12;
    ctx.shadowColor = color;
  }

  // Main body
  ctx.fillStyle = color;
  roundRect(ctx, -hw, -hh, w, h, 8);
  ctx.fill();
  ctx.shadowBlur = 0;

  // Windshield
  ctx.fillStyle = isPlayer ? "rgba(0,200,255,0.55)" : "rgba(100,140,180,0.55)";
  const wsY = isPlayer ? -hh + h * 0.22 : -hh + h * 0.52;
  const wsH = h * 0.22;
  roundRect(ctx, -hw * 0.6, wsY, w * 0.6, wsH, 4);
  ctx.fill();

  // Rear windshield
  const rwY = isPlayer ? hh - h * 0.32 : -hh + h * 0.22;
  const rwH = h * 0.14;
  roundRect(ctx, -hw * 0.55, rwY, w * 0.55, rwH, 4);
  ctx.fill();

  // Headlights / taillights
  const hLY = isPlayer ? -hh + 6 : hh - 12;
  const tLY = isPlayer ? hh - 12 : -hh + 6;

  // Headlights
  ctx.fillStyle = isPlayer ? "#fff8d0" : "#ffcc55";
  [[- hw * 0.55, hLY], [hw * 0.55 - 10, hLY]].forEach(([lx, ly]) => {
    ctx.beginPath(); ctx.ellipse(lx + 5, ly + 4, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
    if (STATE.nightMode && isPlayer) {
      // Headlight beam
      const beam = ctx.createRadialGradient(lx + 5, ly + 4, 0, lx + 5, ly + 4, 60);
      beam.addColorStop(0, "rgba(255,255,200,0.15)");
      beam.addColorStop(1, "transparent");
      ctx.fillStyle = beam;
      ctx.fillRect(lx - 30, ly, 80, 120);
      ctx.fillStyle = "#fff8d0";
    }
  });

  // Taillights
  ctx.fillStyle = isPlayer ? "#ff2222" : "#ff8800";
  [[-hw * 0.55, tLY], [hw * 0.55 - 10, tLY]].forEach(([lx, ly]) => {
    ctx.beginPath(); ctx.ellipse(lx + 5, ly + 4, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
  });

  // Roof stripe
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  roundRect(ctx, -hw * 0.15, -hh + h * 0.06, w * 0.15, h * 0.65, 3);
  ctx.fill();

  ctx.restore();
}

// Helper: rounded rectangle path
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* Draw nitro exhaust particles */
function drawNitroParticles() {
  nitroParticles.forEach(p => {
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.shadowBlur = 10;
    ctx.shadowColor = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  });
  ctx.globalAlpha = 1;
}

/* Speed lines on nitro */
function drawSpeedLines() {
  if (!STATE.nitroActive) return;
  ctx.strokeStyle = "rgba(0,245,255,0.18)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const x = roadLeft + Math.random() * roadW;
    const y = Math.random() * H;
    const len = 40 + Math.random() * 60;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + len); ctx.stroke();
  }
}

// ─────────────────────────────────────────────────────
// 13. SCORE & SPEED LOGIC
// ─────────────────────────────────────────────────────
function updateScore() {
  STATE.score += CFG.scorePerFrame * (STATE.nitroActive ? 1.5 : 1);
  // Increase speed every 500 score points
  const level = Math.floor(STATE.score / 500);
  STATE.speed = Math.min(CFG.baseSpeed + level * CFG.speedIncrement, CFG.maxSpeed);
  if (STATE.nitroActive) STATE.speed = Math.min(STATE.speed * CFG.nitroMultiplier, CFG.maxSpeed * CFG.nitroMultiplier);
}

function updateHUD() {
  document.getElementById("hudScore").textContent     = Math.floor(STATE.score);
  document.getElementById("hudHighScore").textContent = STATE.highScore;
  const kmh = Math.round(STATE.speed * 18); // arbitrary mapping to km/h
  document.getElementById("hudSpeed").textContent     = kmh + " km/h";
  // Nitro bar
  const pct = (STATE.nitro / CFG.nitroDuration) * 100;
  document.getElementById("nitroBar").style.width = pct + "%";
}

// ─────────────────────────────────────────────────────
// 14. PLAYER MOVEMENT
// ─────────────────────────────────────────────────────
function updatePlayer() {
  const movingLeft  = keys["ArrowLeft"]  || keys["KeyA"] || touchLeft;
  const movingRight = keys["ArrowRight"] || keys["KeyD"] || touchRight;
  const nitroPress  = keys["Space"] || touchNitro;

  const speed = 5.5;

  if (movingLeft) {
    player.x  -= speed;
    player.tilt = Math.max(player.tilt - 0.4, -5);
  } else if (movingRight) {
    player.x  += speed;
    player.tilt = Math.min(player.tilt + 0.4, 5);
  } else {
    player.tilt *= 0.8;
  }

  // Clamp inside road
  player.x = Math.max(roadLeft  + player.w / 2,
              Math.min(roadRight - player.w / 2, player.x));

  // Nitro logic
  if (nitroPress && STATE.nitro > 0 && STATE.nitroCooldown === 0) {
    if (!STATE.nitroActive) playNitroSound();
    STATE.nitroActive = true;
    STATE.nitro = Math.max(0, STATE.nitro - 1);
    spawnNitroParticles();
    if (STATE.nitro === 0) {
      STATE.nitroActive = false;
      STATE.nitroCooldown = CFG.nitroRecharge;
    }
  } else {
    STATE.nitroActive = false;
    if (STATE.nitroCooldown > 0) {
      STATE.nitroCooldown--;
    } else {
      STATE.nitro = Math.min(CFG.nitroDuration, STATE.nitro + 0.6);
    }
  }

  // Nitro flash DOM element
  const flash = document.getElementById("nitroFlash") ||
    (() => { const d = document.createElement("div"); d.id="nitroFlash"; document.body.appendChild(d); return d; })();
  flash.classList.toggle("active", STATE.nitroActive);
}

// ─────────────────────────────────────────────────────
// 15. MAIN GAME LOOP
// ─────────────────────────────────────────────────────
function gameLoop() {
  if (STATE.phase !== "playing") return;

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Draw world
  drawRoad();
  drawLaneLines();
  drawSpeedLines();

  // Update & draw traffic
  updateTraffic();
  traffic.forEach(t => drawCar(t.x, t.y, t.w, t.h, t.color, false));

  // Update & draw player
  updatePlayer();
  updateNitroParticles();
  drawNitroParticles();
  drawCar(player.x, player.y, player.w, player.h, STATE.playerColor, true, player.tilt);

  // Scrolling environment
  updateLaneLines(STATE.speed * (STATE.nitroActive ? CFG.nitroMultiplier : 1));
  updateLamps(STATE.speed);

  // Score / speed
  updateScore();
  updateHUD();

  // Audio
  if (audioCtx) updateEngineSound(STATE.speed);

  // Collision
  if (checkCollision()) {
    triggerGameOver();
    return;
  }

  STATE.frameId = requestAnimationFrame(gameLoop);
}

// ─────────────────────────────────────────────────────
// 16. GAME FLOW
// ─────────────────────────────────────────────────────
function startGame() {
  STATE.phase   = "playing";
  STATE.score   = 0;
  STATE.speed   = CFG.baseSpeed;
  STATE.nitro   = CFG.nitroDuration;
  STATE.nitroActive  = false;
  STATE.nitroCooldown = 0;

  traffic.length = 0;
  nitroParticles.length = 0;

  resetPlayer();
  resize();
  initLaneLines();
  initLamps();
  initStars();

  // Ensure AudioContext is resumed (needed on mobile)
  if (!audioCtx) getAudio();
  audioCtx.resume().then(() => {
    startEngine();
    if (STATE.musicOn) startBGMusic();
  });

  // Show HUD, hide menus
  document.getElementById("hud").classList.remove("hidden");
  document.getElementById("startMenu").classList.add("hidden");
  document.getElementById("gameOverMenu").classList.add("hidden");
  document.getElementById("pauseMenu").classList.add("hidden");

  // Touch controls
  injectTouchControls();
  document.getElementById("touchControls").style.display =
    (navigator.maxTouchPoints > 0 || window.matchMedia("(pointer:coarse)").matches) ? "flex" : "none";

  if (STATE.frameId) cancelAnimationFrame(STATE.frameId);
  STATE.frameId = requestAnimationFrame(gameLoop);
}

function triggerGameOver() {
  STATE.phase = "over";
  cancelAnimationFrame(STATE.frameId);
  stopEngine();

  playCrash();

  const score = Math.floor(STATE.score);
  const isNew = score > STATE.highScore;
  if (isNew) {
    STATE.highScore = score;
    localStorage.setItem("neonDriftHS", STATE.highScore);
  }

  document.getElementById("finalScore").textContent     = score;
  document.getElementById("finalHighScore").textContent = STATE.highScore;
  document.getElementById("newRecordBadge").classList.toggle("hidden", !isNew);

  document.getElementById("hud").classList.add("hidden");
  document.getElementById("gameOverMenu").classList.remove("hidden");
}

function togglePause() {
  if (STATE.phase === "playing") {
    STATE.phase = "paused";
    cancelAnimationFrame(STATE.frameId);
    stopEngine();
    document.getElementById("pauseMenu").classList.remove("hidden");
  } else if (STATE.phase === "paused") {
    STATE.phase = "playing";
    document.getElementById("pauseMenu").classList.add("hidden");
    audioCtx.resume().then(() => startEngine());
    STATE.frameId = requestAnimationFrame(gameLoop);
  }
}

function goToMenu() {
  STATE.phase = "menu";
  cancelAnimationFrame(STATE.frameId);
  stopEngine();
  stopBGMusic();

  document.getElementById("hud").classList.add("hidden");
  document.getElementById("gameOverMenu").classList.add("hidden");
  document.getElementById("pauseMenu").classList.add("hidden");
  document.getElementById("startMenu").classList.remove("hidden");

  // Draw a static background on canvas
  ctx.clearRect(0, 0, W, H);
  initStars();
  drawRoad();
}

// ─────────────────────────────────────────────────────
// 17. UI EVENT LISTENERS
// ─────────────────────────────────────────────────────

// Play button
document.getElementById("playBtn").addEventListener("click", startGame);

// Restart button (game over screen)
document.getElementById("restartBtn").addEventListener("click", startGame);

// Main menu button (game over)
document.getElementById("menuBtn").addEventListener("click", goToMenu);

// Resume button
document.getElementById("resumeBtn").addEventListener("click", togglePause);

// Pause → restart
document.getElementById("pauseRestartBtn").addEventListener("click", startGame);

// In-game pause button
document.getElementById("pauseBtn").addEventListener("click", togglePause);

// Car color selector
document.querySelectorAll(".car-option").forEach(opt => {
  opt.addEventListener("click", () => {
    document.querySelectorAll(".car-option").forEach(o => o.classList.remove("selected"));
    opt.classList.add("selected");
    const colorName = opt.dataset.color;
    STATE.playerColor = CFG.carColors[colorName];
    document.documentElement.style.setProperty("--player-color", STATE.playerColor);
  });
});

// Night mode toggle
document.getElementById("nightToggle").addEventListener("change", e => {
  STATE.nightMode = e.target.checked;
  document.getElementById("modeLabel").textContent = STATE.nightMode ? "NIGHT" : "DAY";
  // Redraw menu background
  if (STATE.phase === "menu") { ctx.clearRect(0,0,W,H); initStars(); drawRoad(); }
});

// Music toggle
document.getElementById("musicToggle").addEventListener("change", e => {
  STATE.musicOn = e.target.checked;
  document.getElementById("musicLabel").textContent = STATE.musicOn ? "ON" : "OFF";
  if (!STATE.musicOn) stopBGMusic();
  else if (STATE.phase === "playing") { if (audioCtx) startBGMusic(); }
});

// ─────────────────────────────────────────────────────
// 18. INITIALISE
// ─────────────────────────────────────────────────────
function init() {
  // Load high score from localStorage
  STATE.highScore = parseInt(localStorage.getItem("neonDriftHS") || "0", 10);
  document.getElementById("menuHighScore").textContent = STATE.highScore;
  document.getElementById("hudHighScore").textContent  = STATE.highScore;

  // Set default car color
  STATE.playerColor = CFG.carColors.cyan;

  // Draw static background on menu
  resize();
  initStars();
  ctx.clearRect(0, 0, W, H);
  drawRoad();
}

init();
