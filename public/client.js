const socket = io();

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d", { alpha: false });

let myId = null;
let worldSize = 3200;
let state = { players: [], foods: [], viruses: [], leaderboard: [] };
let my = null;
let target = { x: 0, y: 0 };
let mouse = { x: 0, y: 0 };

const nameInput = document.getElementById("name");
const playBtn = document.getElementById("play");
const themeSel = document.getElementById("theme");
const lbEl = document.getElementById("leaderboard");
const toggleMass = document.getElementById("toggleMass");
const toggleNames = document.getElementById("toggleNames");

function loadPrefs() {
  nameInput.value = localStorage.getItem("agar_name") || "";
  const theme = localStorage.getItem("agar_theme") || "dark";
  themeSel.value = theme;
  document.documentElement.setAttribute("data-theme", theme);
  toggleMass.checked = (localStorage.getItem("agar_showMass") ?? "1") === "1";
  toggleNames.checked = (localStorage.getItem("agar_showNames") ?? "1") === "1";
}
loadPrefs();

themeSel.addEventListener("change", () => {
  const v = themeSel.value;
  document.documentElement.setAttribute("data-theme", v);
  localStorage.setItem("agar_theme", v);
  document.documentElement.dataset.theme = v;
});

toggleMass.addEventListener("change", () => {
  localStorage.setItem("agar_showMass", toggleMass.checked ? "1" : "0");
});
toggleNames.addEventListener("change", () => {
  localStorage.setItem("agar_showNames", toggleNames.checked ? "1" : "0");
});

playBtn.addEventListener("click", () => {
  const name = nameInput.value.trim() || "Player";
  localStorage.setItem("agar_name", name);
  socket.emit("join", { name });
});

socket.on("init", ({ id, world }) => {
  myId = id;
  worldSize = world.size;
});

socket.on("state", s => {
  state = s;
  const myCells = s.players.filter(p => p.owner === myId);
  if (myCells.length) {
    let mass = 0, x = 0, y = 0;
    for (const c of myCells) {
      mass += c.mass;
      x += c.x * c.mass;
      y += c.y * c.mass;
    }
    my = { x: x / mass, y: y / mass, mass, cells: myCells };
  } else {
    my = null;
  }
});

function resize() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

canvas.addEventListener("mousemove", e => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
});
canvas.addEventListener("touchmove", e => {
  const t = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  mouse.x = t.clientX - rect.left;
  mouse.y = t.clientY - rect.top;
}, { passive: true });

setInterval(() => {
  if (!my) return;
  const dpr = window.devicePixelRatio || 1;
  const cam = getCamera();
  target.x = cam.x + (mouse.x - canvas.width / (2 * dpr)) / cam.zoom;
  target.y = cam.y + (mouse.y - canvas.height / (2 * dpr)) / cam.zoom;
  socket.emit("input", { tx: target.x, ty: target.y });
}, 50);

window.addEventListener("keydown", e => {
  if (!my) return;
  if (e.code === "KeyW") socket.emit("eject");
  if (e.code === "Space") socket.emit("split");
});

function toRadius(mass) { return Math.sqrt(mass) * 4; }

function getCamera() {
  if (!my) return { x: 0, y: 0, zoom: 1 };
  const vw = canvas.width / (window.devicePixelRatio || 1);
  const vh = canvas.height / (window.devicePixelRatio || 1);
  const zoom = Math.max(0.2, Math.min(1.5, 220 / toRadius(my.mass)));
  return { x: my.x, y: my.y, zoom };
}

function drawGrid(cam) {
  const step = 100;
  const left = -worldSize, right = worldSize, top = -worldSize, bottom = worldSize;
  ctx.lineWidth = 1 / cam.zoom;
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  ctx.strokeStyle = theme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)";
  for (let x = Math.ceil(left / step) * step; x <= right; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let y = Math.ceil(top / step) * step; y <= bottom; y += step) {
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
}

function draw() {
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  ctx.fillStyle = theme === "dark" ? "#0b0e11" : "#f5f7fb";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const cam = getCamera();
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  // Plain black or white world background instead of gray
  ctx.fillStyle = theme === "dark" ? "#000000" : "#ffffff";
  ctx.fillRect(-worldSize, -worldSize, worldSize * 2, worldSize * 2);

  drawGrid(cam);

  // Render each food pellet using its own color
  for (const f of state.foods) {
    ctx.beginPath();
    ctx.fillStyle = f.color;
    ctx.arc(f.x, f.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw viruses as green circles
  for (const v of state.viruses) {
    ctx.beginPath();
    ctx.fillStyle = "#33aa33";
    ctx.arc(v.x, v.y, v.r, 0, Math.PI * 2);
    ctx.fill();
  }

  const showMass = toggleMass.checked;
  const showNames = toggleNames.checked;

  const sorted = state.players.slice().sort((a, b) => a.r - b.r);
  for (const p of sorted) {
    ctx.beginPath();
    ctx.fillStyle = p.color;
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();

    if ((showNames || showMass) && p.r * cam.zoom > 10) {
      ctx.fillStyle = theme === "dark" ? "#ffffff" : "#0b0e11";
      ctx.font = `${Math.max(12, Math.min(32, p.r / 2))}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let y = p.y;
      if (showNames) {
        ctx.fillText(p.name, p.x, y);
        y += Math.max(12, Math.min(28, p.r / 3));
      }
      if (showMass) ctx.fillText(String(p.mass), p.x, y);
    }
  }

  ctx.restore();

  lbEl.innerHTML = `<h3>Leaderboard</h3>${state.leaderboard.map((e, i) => `
    <div class="entry"><span>${i + 1}. ${e.name}</span><span>${e.mass}</span></div>
  `).join("")}`;

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
