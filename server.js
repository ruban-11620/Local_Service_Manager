const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile, execFileSync } = require("node:child_process");

const HOST = "127.0.0.1";
const PORT = 4173;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "services.json");
const PIDS_FILE = path.join(ROOT, ".pids.json");
const MAX_LOG_LINES = 500;

let services = [];
const processes = new Map();
const clients = new Set();

function loadServices() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(raw)) return [];
    // Always initialize runtime-only fields fresh so no service appears "running" on startup
    return raw.map(s => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      command: String(s.command || "npm start").trim() || "npm start",
      logs: []
    }));
  } catch {
    return [];
  }
}

function save() {
  const clean = services.map(({ id, name, cwd, command }) => ({
    id,
    name,
    cwd,
    command: command || "npm start"
  }));
  fs.writeFileSync(DATA_FILE, JSON.stringify(clean, null, 2));
}

function writePidFile(extraPidsMap) {
  const entries = [];
  for (const [id, child] of processes.entries()) {
    if (child?.pid) {
      entries.push({
        id,
        pid: child.pid,
        descendants: extraPidsMap?.get(id) || child._descendants || []
      });
    }
  }
  try {
    if (entries.length === 0) {
      if (fs.existsSync(PIDS_FILE)) fs.unlinkSync(PIDS_FILE);
    } else {
      fs.writeFileSync(PIDS_FILE, JSON.stringify(entries, null, 2));
    }
  } catch {}
}

function trackDescendants(id, child) {
  if (process.platform !== "win32" || !child?.pid) return;
  setTimeout(() => {
    if (processes.get(id) !== child) return;
    execFile("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `$q = @(${Number(child.pid)}); $all = @(); while ($q.Count -gt 0) { $cur = $q[0]; $q = @($q | Select-Object -Skip 1); $ch = Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $cur) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId; foreach ($c in $ch) { $all += $c; $q += $c } }; $all -join ','`
    ], { encoding: "utf8", windowsHide: true, timeout: 6000 }, (err, stdout) => {
      if (err || processes.get(id) !== child) return;
      const pids = String(stdout || "").trim().split(",").map(Number).filter(Boolean);
      if (pids.length > 0) {
        child._descendants = pids;
        writePidFile();
      }
    });
  }, 1500);
}

function clearPidFile() {
  try {
    if (fs.existsSync(PIDS_FILE)) fs.unlinkSync(PIDS_FILE);
  } catch {}
}

function killProcessTreeSync(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    } catch {}
  } else {
    try { process.kill(-pid, "SIGTERM"); }
    catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  }
}

function cleanupOrphanPids() {
  if (!fs.existsSync(PIDS_FILE)) return;
  try {
    const stale = JSON.parse(fs.readFileSync(PIDS_FILE, "utf8"));
    if (Array.isArray(stale) && stale.length > 0) {
      const candidatePids = new Set();
      for (const entry of stale) {
        if (Number(entry?.pid)) candidatePids.add(Number(entry.pid));
        if (Array.isArray(entry?.descendants)) {
          for (const d of entry.descendants) {
            if (Number(d)) candidatePids.add(Number(d));
          }
        }
      }
      if (candidatePids.size > 0) {
        if (process.platform === "win32") {
          try {
            const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], {
              encoding: "utf8",
              windowsHide: true,
              maxBuffer: 10 * 1024 * 1024
            });
            const toKill = [];
            for (const line of out.split(/\r?\n/)) {
              if (!line) continue;
              const match = line.match(/^"([^"]+)","(\d+)"/);
              if (!match) continue;
              const [, imageName, pidStr] = match;
              const pid = Number(pidStr);
              if (candidatePids.has(pid) && /^(node|cmd)\.exe$/i.test(imageName)) {
                toKill.push("/PID", String(pid));
              }
            }
            if (toKill.length > 0) {
              try {
                execFileSync("taskkill", ["/T", "/F", ...toKill], {
                  stdio: "ignore",
                  windowsHide: true
                });
              } catch {}
            }
          } catch {}
        } else {
          for (const pid of candidatePids) {
            try {
              process.kill(pid, 0);
              killProcessTreeSync(pid);
            } catch {}
          }
        }
      }
    }
  } catch {}
  clearPidFile();
}

services = loadServices();
cleanupOrphanPids();
// Normalize services.json if it previously stored logs or stale lastStatus
save();

function log(id, message) {
  const service = services.find(s => s.id === id);
  if (!service) return;
  service.logs ||= [];
  const line = `[${new Date().toLocaleTimeString()}] ${String(message).replace(/\r/g, "")}`;
  service.logs.push(line);
  if (service.logs.length > MAX_LOG_LINES) service.logs.splice(0, service.logs.length - MAX_LOG_LINES);
  broadcast({ type: "log", id, line });
}

function publicService(s) {
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    command: s.command || "npm start",
    status: processes.has(s.id) ? "running" : "stopped",
    logs: s.logs || []
  };
}

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function startService(service) {
  if (processes.has(service.id)) return false;
  const cmd = String(service.command || "npm start").trim() || "npm start";
  log(service.id, `Starting: ${cmd} (${service.cwd})`);
  const child = spawn(cmd, [], {
    cwd: service.cwd,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: { ...process.env, FORCE_COLOR: "0" }
  });
  processes.set(service.id, child);
  writePidFile();
  trackDescendants(service.id, child);

  child.stdout?.on("data", data => log(service.id, data.toString()));
  child.stderr?.on("data", data => log(service.id, data.toString()));
  child.on("error", err => log(service.id, `ERROR: ${err.message}`));
  child.on("close", (code, signal) => {
    if (processes.get(service.id) === child) {
      processes.delete(service.id);
      writePidFile();
      log(service.id, `Process exited (code=${code}, signal=${signal || "none"}).`);
      broadcast({ type: "changed" });
    }
  });
  return true;
}

function stopService(id) {
  const child = processes.get(id);
  if (!child) return Promise.resolve(false);
  log(id, "Stop requested...");
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (processes.get(id) === child) {
        processes.delete(id);
        writePidFile();
      }
      broadcast({ type: "changed" });
      resolve(true);
    };

    child.once("close", finish);
    const safetyTimer = setTimeout(finish, 2500);

    if (process.platform === "win32" && child.pid) {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
        setTimeout(() => {
          clearTimeout(safetyTimer);
          finish();
        }, 120);
      });
    } else if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch { try { child.kill("SIGTERM"); } catch {} }
    } else {
      clearTimeout(safetyTimer);
      finish();
    }
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/services") {
    return send(res, 200, services.map(publicService));
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "null"
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/services") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const rawCwd = String(body.cwd || "").trim();
    const command = String(body.command || "npm start").trim() || "npm start";
    if (!name || !rawCwd) return send(res, 400, { error: "Service name and folder path are required." });
    const cwd = path.resolve(rawCwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return send(res, 400, { error: "Directory not found. Enter a valid absolute folder path." });
    }
    if (/^npm(\.cmd)?\s+start\b/i.test(command) && !fs.existsSync(path.join(cwd, "package.json"))) {
      return send(res, 400, { error: "No package.json found in that folder. Enter the repository root folder." });
    }
    const id = require("node:crypto").randomUUID();
    services.push({ id, name, cwd, command, logs: [] });
    save();
    broadcast({ type: "changed" });
    return send(res, 201, publicService(services[services.length - 1]));
  }

  if ((req.method === "PUT" || req.method === "PATCH") && /^\/api\/services\/([^/]+)$/.test(url.pathname)) {
    const id = url.pathname.split("/").pop();
    const service = services.find(s => s.id === id);
    if (!service) return send(res, 404, { error: "Service not found." });

    const body = await readBody(req);
    const name = String(body.name ?? service.name).trim();
    const rawCwd = String(body.cwd ?? service.cwd).trim();
    const command = String(body.command ?? service.command ?? "npm start").trim() || "npm start";

    if (!name || !rawCwd) return send(res, 400, { error: "Display name and repository path are required." });
    const cwd = path.resolve(rawCwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return send(res, 400, { error: "Directory not found. Enter a valid absolute folder path." });
    }
    if (/^npm(\.cmd)?\s+start\b/i.test(command) && !fs.existsSync(path.join(cwd, "package.json"))) {
      return send(res, 400, { error: "No package.json found in that folder for npm start." });
    }
    if (processes.has(id) && (cwd !== service.cwd || command !== (service.command || "npm start"))) {
      return send(res, 409, { error: "Stop the service before changing its repository path or start command." });
    }

    service.name = name;
    service.cwd = cwd;
    service.command = command;
    save();
    broadcast({ type: "changed" });
    return send(res, 200, publicService(service));
  }

  const match = url.pathname.match(/^\/api\/services\/([^/]+)\/(start|stop|restart)$/);
  if (req.method === "POST" && match) {
    const [, id, action] = match;
    const service = services.find(s => s.id === id);
    if (!service) return send(res, 404, { error: "Service not found." });

    if (action === "stop") {
      await stopService(id);
      return send(res, 200, { ok: true });
    }

    if (action === "restart") {
      await stopService(id);
      startService(service);
      broadcast({ type: "changed" });
      return send(res, 200, { ok: true });
    }

    if (processes.has(id)) return send(res, 409, { error: "Service is already running." });
    startService(service);
    broadcast({ type: "changed" });
    return send(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/services/")) {
    const id = url.pathname.split("/").pop();
    if (processes.has(id)) return send(res, 409, { error: "Stop the service before removing it." });
    services = services.filter(s => s.id !== id);
    save();
    broadcast({ type: "changed" });
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/start-all") {
    for (const s of services) {
      startService(s);
    }
    broadcast({ type: "changed" });
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/stop-all") {
    await Promise.all(services.map(s => stopService(s.id)));
    broadcast({ type: "changed" });
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET") {
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(PUBLIC, requested);
    if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, "index.html")) {
      return send(res, 403, { error: "Forbidden" });
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: "Not found" });
    const ext = path.extname(file);
    res.writeHead(200, { "Content-Type": ext === ".html" ? "text/html; charset=utf-8" : "text/plain" });
    return fs.createReadStream(file).pipe(res);
  }

  send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => send(res, 500, { error: err.message }));
});
server.listen(PORT, HOST, () => {
  console.log(`Local Service Manager: http://${HOST}:${PORT}`);
});

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [id, child] of processes.entries()) {
    if (child?.pid) killProcessTreeSync(child.pid);
    processes.delete(id);
  }
  clearPidFile();
  for (const res of clients) {
    try { res.end(); } catch {}
  }
  clients.clear();
  try { server.close(); } catch {}
  process.exit(exitCode);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => shutdown(0));
}

process.on("exit", () => {
  for (const child of processes.values()) {
    if (child?.pid) killProcessTreeSync(child.pid);
  }
  clearPidFile();
});
