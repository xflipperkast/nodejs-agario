import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

const TICK_RATE = 30;
const WORLD_SIZE = 3200;
const START_MASS = 25;
// Double the food count so the map has more pellets to eat
const FOOD_COUNT = 3000;
const FOOD_MASS = 1.5;
const FOOD_RESPAWN_BATCH = 100;
const PLAYER_EAT_RATIO = 1.25;
const EJECT_MASS = 14;
const EJECT_SPEED = 400;
const MAX_EJECT_PER_SEC = 7;
const VIRUS_COUNT = 15;
const VIRUS_MASS = 100;

const players = new Map();
const foods = new Map();
const ejects = new Map();
const viruses = new Map();

function rand(min, max) { return Math.random() * (max - min) + min; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function toRadius(mass) { return Math.sqrt(mass) * 4; }

function spawnFood(id) {
  // Each food pellet gets a random color so the map looks more vibrant
  const color = `hsl(${Math.floor(rand(0, 360))}deg 80% 55%)`;
  foods.set(id, {
    id,
    x: rand(-WORLD_SIZE, WORLD_SIZE),
    y: rand(-WORLD_SIZE, WORLD_SIZE),
    color
  });
}

for (let i = 0; i < FOOD_COUNT; i++) spawnFood(`f${i}`);

function spawnVirus(id) {
  viruses.set(id, {
    id,
    x: rand(-WORLD_SIZE, WORLD_SIZE),
    y: rand(-WORLD_SIZE, WORLD_SIZE),
    r: toRadius(VIRUS_MASS)
  });
}
for (let i = 0; i < VIRUS_COUNT; i++) spawnVirus(`v${i}`);

io.on("connection", socket => {
  socket.on("join", ({ name }) => {
    const color = `hsl(${Math.floor(rand(0,360))}deg 80% 55%)`;
    const player = {
      id: socket.id,
      name: String(name || "Player").slice(0, 20),
      tx: 0,
      ty: 0,
      color,
      alive: true,
      score: 0,
      lastInput: Date.now(),
      ejects: 0,
      lastEject: 0,
      cells: [{
        x: rand(-WORLD_SIZE, WORLD_SIZE),
        y: rand(-WORLD_SIZE, WORLD_SIZE),
        mass: START_MASS,
        vx: 0,
        vy: 0,
        recombine: 0
      }],
      mass: START_MASS
    };
    players.set(socket.id, player);
    socket.emit("init", {
      id: socket.id,
      world: { size: WORLD_SIZE }
    });
  });

  socket.on("input", ({ tx, ty }) => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    p.tx = tx;
    p.ty = ty;
    p.lastInput = Date.now();
  });

  socket.on("eject", () => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    const now = Date.now();
    if (now - p.lastEject > 1000) { p.lastEject = now; p.ejects = 0; }
    if (p.ejects >= MAX_EJECT_PER_SEC) return;
    let cell = p.cells.reduce((a, b) => (a.mass > b.mass ? a : b), p.cells[0]);
    if (!cell || cell.mass <= EJECT_MASS) return;
    cell.mass -= EJECT_MASS;
    p.mass -= EJECT_MASS;
    const angle = Math.atan2(p.ty - cell.y, p.tx - cell.x);
    const id = `e${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
    const r = toRadius(cell.mass);
    ejects.set(id, {
      id,
      x: cell.x + Math.cos(angle) * (r + toRadius(EJECT_MASS)),
      y: cell.y + Math.sin(angle) * (r + toRadius(EJECT_MASS)),
      vx: Math.cos(angle) * EJECT_SPEED,
      vy: Math.sin(angle) * EJECT_SPEED,
      color: p.color
    });
    p.ejects++;
  });

  socket.on("split", () => {
    const p = players.get(socket.id);
    if (!p || !p.alive) return;
    if (p.cells.length >= 16) return;
    let cell = p.cells.reduce((a, b) => (a.mass > b.mass ? a : b), p.cells[0]);
    if (!cell || cell.mass < 35) return;
    const angle = Math.atan2(p.ty - cell.y, p.tx - cell.x);
    const newMass = cell.mass / 2;
    const r = toRadius(newMass);
    cell.mass = newMass;
    cell.vx += Math.cos(angle) * EJECT_SPEED;
    cell.vy += Math.sin(angle) * EJECT_SPEED;
    cell.recombine = Date.now() + 15000;
    const newCell = {
      x: cell.x + Math.cos(angle) * (r * 2),
      y: cell.y + Math.sin(angle) * (r * 2),
      mass: newMass,
      vx: Math.cos(angle) * EJECT_SPEED,
      vy: Math.sin(angle) * EJECT_SPEED,
      recombine: Date.now() + 15000
    };
    p.cells.push(newCell);
  });

  socket.on("disconnect", () => {
    players.delete(socket.id);
  });
});

function step(dt) {
  for (const [id, e] of ejects) {
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.vx *= 0.9;
    e.vy *= 0.9;
    e.x = clamp(e.x, -WORLD_SIZE, WORLD_SIZE);
    e.y = clamp(e.y, -WORLD_SIZE, WORLD_SIZE);
  }

  const foodIds = Array.from(foods.keys());
  const ejectIds = Array.from(ejects.keys());
  const playerArr = Array.from(players.values());
  const now = Date.now();

  for (const p of playerArr) {
    if (!p.alive) continue;
    for (const c of p.cells) {
      const dx = p.tx - c.x;
      const dy = p.ty - c.y;
      const dist = Math.hypot(dx, dy) || 1;
      c.vx *= 0.9;
      c.vy *= 0.9;
      // Small cells should move quickly while larger ones slow down
      const speed = 150 / Math.sqrt(c.mass);
      c.vx += (dx / dist) * speed;
      c.vy += (dy / dist) * speed;
      c.x = clamp(c.x + c.vx * dt, -WORLD_SIZE, WORLD_SIZE);
      c.y = clamp(c.y + c.vy * dt, -WORLD_SIZE, WORLD_SIZE);

      const cr = toRadius(c.mass);
      for (let i = 0; i < foodIds.length; i++) {
        const fid = foodIds[i];
        const f = foods.get(fid);
        if (!f) continue;
        if (Math.hypot(f.x - c.x, f.y - c.y) < cr) {
          c.mass += FOOD_MASS;
          foods.delete(fid);
          foodIds.splice(i, 1);
          i--;
        }
      }

      for (let i = 0; i < ejectIds.length; i++) {
        const eid = ejectIds[i];
        const e = ejects.get(eid);
        if (!e) continue;
        if (Math.hypot(e.x - c.x, e.y - c.y) < cr) {
          c.mass += EJECT_MASS * 0.7;
          ejects.delete(eid);
          ejectIds.splice(i, 1);
          i--;
        }
      }

      for (const [vid, v] of viruses) {
        if (Math.hypot(v.x - c.x, v.y - c.y) < cr + v.r && c.mass > VIRUS_MASS) {
          let remaining = c.mass + VIRUS_MASS;
          viruses.delete(vid);
          spawnVirus(`vx${Date.now()}_${Math.random().toString(36).slice(2,7)}`);
          const masses = [];
          while (remaining > 0 && masses.length < 16 && p.cells.length + masses.length < 16) {
            const m = Math.min(VIRUS_MASS, remaining);
            masses.push(m);
            remaining -= m;
          }
          c.mass = masses[0];
          const base = Math.random() * Math.PI * 2;
          c.vx = Math.cos(base) * EJECT_SPEED;
          c.vy = Math.sin(base) * EJECT_SPEED;
          c.recombine = now + 15000;
          for (let k = 1; k < masses.length; k++) {
            const ang = Math.random() * Math.PI * 2;
            p.cells.push({
              x: c.x,
              y: c.y,
              mass: masses[k],
              vx: Math.cos(ang) * EJECT_SPEED,
              vy: Math.sin(ang) * EJECT_SPEED,
              recombine: now + 15000
            });
          }
          break;
        }
      }
    }
    p.mass = p.cells.reduce((sum, c) => sum + c.mass, 0);
    p.score = Math.max(p.score, p.mass);
  }

  // Merge cells if possible
  for (const p of playerArr) {
    if (!p.alive) continue;
    for (let i = 0; i < p.cells.length; i++) {
      const a = p.cells[i];
      for (let j = i + 1; j < p.cells.length; j++) {
        const b = p.cells[j];
        if (now < a.recombine || now < b.recombine) continue;
        if (Math.hypot(b.x - a.x, b.y - a.y) < toRadius(a.mass) + toRadius(b.mass)) {
          const total = a.mass + b.mass;
          a.x = (a.x * a.mass + b.x * b.mass) / total;
          a.y = (a.y * a.mass + b.y * b.mass) / total;
          a.vx = (a.vx * a.mass + b.vx * b.mass) / total;
          a.vy = (a.vy * a.mass + b.vy * b.mass) / total;
          a.mass = total;
          p.cells.splice(j, 1);
          j--;
        }
      }
    }
    p.mass = p.cells.reduce((sum, c) => sum + c.mass, 0);
    p.score = Math.max(p.score, p.mass);
  }

  // Respawn food
  let respawn = FOOD_COUNT - foods.size;
  if (respawn > 0) {
    const batch = Math.min(respawn, FOOD_RESPAWN_BATCH);
    for (let i = 0; i < batch; i++) spawnFood(`fx${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${i}`);
  }

  // Handle player vs player collisions
  for (let i = 0; i < playerArr.length; i++) {
    const pa = playerArr[i];
    if (!pa.alive) continue;
    for (let ai = pa.cells.length - 1; ai >= 0; ai--) {
      const ca = pa.cells[ai];
      for (let j = i + 1; j < playerArr.length; j++) {
        const pb = playerArr[j];
        if (!pb.alive) continue;
        for (let bi = pb.cells.length - 1; bi >= 0; bi--) {
          const cb = pb.cells[bi];
          const d = Math.hypot(cb.x - ca.x, cb.y - ca.y);
          const ra = toRadius(ca.mass);
          const rb = toRadius(cb.mass);
          if (d < Math.max(ra, rb) && d !== 0) {
            if (ca.mass > cb.mass * PLAYER_EAT_RATIO) {
              ca.mass += cb.mass * 0.9;
              pb.cells.splice(bi, 1);
              if (pb.cells.length === 0) { pb.alive = false; players.delete(pb.id); }
            } else if (cb.mass > ca.mass * PLAYER_EAT_RATIO) {
              cb.mass += ca.mass * 0.9;
              pa.cells.splice(ai, 1);
              if (pa.cells.length === 0) { pa.alive = false; players.delete(pa.id); }
              break;
            }
          }
        }
      }
    }
  }

  for (const p of playerArr) {
    p.mass = p.cells.reduce((sum, c) => sum + c.mass, 0);
    p.score = Math.max(p.score, p.mass);
  }
}

function snapshot() {
  const ps = [];
  for (const p of players.values()) {
    for (let i = 0; i < p.cells.length; i++) {
      const c = p.cells[i];
      ps.push({
        id: `${p.id}:${i}`,
        owner: p.id,
        name: p.name,
        x: Math.round(c.x * 100) / 100,
        y: Math.round(c.y * 100) / 100,
        r: Math.round(toRadius(c.mass) * 100) / 100,
        color: p.color,
        mass: Math.round(c.mass * 10) / 10
      });
    }
  }
  const top = Array.from(players.values())
    .map(pl => ({ name: pl.name, mass: Math.round(pl.mass * 10) / 10 }))
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 10);
  const fs = [];
  for (const f of foods.values()) fs.push({ x: f.x, y: f.y, color: f.color });
  for (const e of ejects.values()) fs.push({ x: e.x, y: e.y, color: e.color });
  const vs = [];
  for (const v of viruses.values()) vs.push({ x: v.x, y: v.y, r: v.r });
  return { players: ps, foods: fs, viruses: vs, leaderboard: top };
}

setInterval(() => {
  step(1 / TICK_RATE);
  const snap = snapshot();
  io.emit("state", snap);
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
// Log a message when the server starts so tests can confirm startup
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
