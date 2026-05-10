import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import WebSocket, { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';

const port = Number(process.env.CMS_SERVER_PORT || 4377);
const host = process.env.CMS_SERVER_HOST || '0.0.0.0';
const publicHost = process.env.CMS_PUBLIC_HOST || '';
const configuredCommandTimeoutMs = Number(process.env.CMS_COMMAND_TIMEOUT_MS || 90_000);
const commandTimeoutMs = Number.isFinite(configuredCommandTimeoutMs) && configuredCommandTimeoutMs > 0
  ? configuredCommandTimeoutMs
  : 90_000;
const adminToken = process.env.CMS_ADMIN_TOKEN || 'change-this-admin-token';
const enrollmentToken = process.env.CMS_ENROLLMENT_TOKEN || 'change-this-enrollment-token';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const devices = new Map();
const controllers = new Set();
const pendingCommands = new Map();
const screenSubscribers = new Map();
const auditLog = [];

app.get('/health', (_req, res) => {
  res.json({ ok: true, devices: devices.size, controllers: controllers.size });
});

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    listen: { host, port },
    urls: getServerUrls(),
    devices: serializeDevices(),
    controllers: controllers.size,
    audit: auditLog.slice(-20)
  });
});

app.get('/', (_req, res) => {
  res.type('html').send(renderStatusPage());
});

wss.on('connection', (socket) => {
  socket.isAlive = true;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: 'error', message: 'Invalid JSON message.' });
      return;
    }

    routeMessage(socket, message);
  });

  socket.on('close', () => {
    if (socket.role === 'agent' && socket.deviceId) {
      const device = devices.get(socket.deviceId);
      if (device?.socket === socket) {
        device.status = 'offline';
        device.socket = null;
        device.lastSeen = new Date().toISOString();
        appendAudit('device.offline', { deviceId: device.id, name: device.name });
        failPendingCommandsForDevice(device.id, 'Device went offline before the command completed.');
        broadcastDevices();
      }
    }

    failPendingCommandsForController(socket, 'Controller disconnected before the command completed.');
    controllers.delete(socket);
    unsubscribeControllerFromAllScreens(socket);
  });
});

setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }

    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

server.on('error', (error) => {
  console.error(`CMS coordinator failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`CMS coordinator listening on ${host}:${port}`);
  for (const url of getServerUrls()) {
    console.log(`  ${url.http}  (${url.ws})`);
  }
});

function routeMessage(socket, message) {
  if (!socket.role) {
    handleAuth(socket, message);
    return;
  }

  if (socket.role === 'controller') {
    handleControllerMessage(socket, message);
    return;
  }

  if (socket.role === 'agent') {
    handleAgentMessage(socket, message);
  }
}

function handleAuth(socket, message) {
  if (message.type !== 'hello') {
    send(socket, { type: 'error', message: 'Authenticate with hello first.' });
    socket.close();
    return;
  }

  if (message.role === 'controller') {
    if (message.token !== adminToken) {
      send(socket, { type: 'error', message: 'Invalid admin token.' });
      socket.close();
      return;
    }

    socket.role = 'controller';
    controllers.add(socket);
    send(socket, { type: 'hello:ok', role: 'controller' });
    send(socket, { type: 'devices', devices: serializeDevices() });
    send(socket, { type: 'audit', entries: auditLog.slice(-100) });
    return;
  }

  if (message.role === 'agent') {
    if (message.token !== enrollmentToken) {
      send(socket, { type: 'error', message: 'Invalid enrollment token.' });
      socket.close();
      return;
    }

    const previousDevice = findReusableDevice(message);
    const deviceId = message.deviceId || previousDevice?.id || nanoid();
    const device = {
      id: deviceId,
      name: message.name || 'Unnamed device',
      os: message.os || 'unknown',
      status: 'online',
      lastSeen: new Date().toISOString(),
      socket
    };

    socket.role = 'agent';
    socket.deviceId = deviceId;
    devices.set(deviceId, device);
    send(socket, { type: 'hello:ok', role: 'agent', deviceId });
    appendAudit('device.online', { deviceId, name: device.name });
    broadcastDevices();
    broadcastAudit();
    return;
  }

  send(socket, { type: 'error', message: 'Unknown role.' });
  socket.close();
}

function handleControllerMessage(socket, message) {
  if (message.type === 'devices:list') {
    send(socket, { type: 'devices', devices: serializeDevices() });
    return;
  }

  if (message.type === 'command:run') {
    const device = devices.get(message.deviceId);

    if (!device || device.status !== 'online' || !device.socket) {
      send(socket, { type: 'command:error', message: 'Device is not online.' });
      return;
    }

    const commandId = nanoid();
    const timeout = setTimeout(() => {
      const pending = pendingCommands.get(commandId);
      if (!pending) {
        return;
      }

      pendingCommands.delete(commandId);
      send(pending.controller, { type: 'command:error', commandId, message: 'Command timed out before the agent returned a result.' });
      appendAudit('command.failed', { commandId, deviceId: pending.deviceId, reason: 'timeout' });
      broadcastAudit();
    }, commandTimeoutMs);

    pendingCommands.set(commandId, { controller: socket, deviceId: device.id, timeout });
    appendAudit('command.requested', {
      commandId,
      deviceId: device.id,
      command: message.command,
      args: redactCommandArgs(message.command, message.args || [])
    });

    send(device.socket, {
      type: 'command:run',
      commandId,
      command: message.command,
      args: message.args || []
    });
    broadcastAudit();
    return;
  }

  if (message.type === 'screen:stream:start') {
    const device = devices.get(message.deviceId);

    if (!device || device.status !== 'online' || !device.socket) {
      send(socket, { type: 'screen:error', deviceId: message.deviceId, message: 'Device is not online.' });
      return;
    }

    subscribeControllerToScreen(socket, device.id);
    appendAudit('screen.stream.started', { deviceId: device.id });
    send(device.socket, {
      type: 'screen:stream:start',
      fps: Number(message.fps || 1)
    });
    broadcastAudit();
    return;
  }

  if (message.type === 'screen:stream:stop') {
    const device = devices.get(message.deviceId);
    unsubscribeControllerFromScreen(socket, message.deviceId);
    appendAudit('screen.stream.stopped', { deviceId: message.deviceId });

    if (device?.socket && !screenSubscribers.has(message.deviceId)) {
      send(device.socket, { type: 'screen:stream:stop' });
    }

    broadcastAudit();
    return;
  }

  send(socket, { type: 'error', message: `Unsupported controller message: ${message.type}` });
}

function handleAgentMessage(_socket, message) {
  if (message.type === 'heartbeat') {
    const device = devices.get(message.deviceId);
    if (device) {
      device.lastSeen = new Date().toISOString();
      device.status = 'online';
      broadcastDevices();
    }
    return;
  }

  if (message.type === 'command:result') {
    const pending = pendingCommands.get(message.commandId);
    pendingCommands.delete(message.commandId);

    if (!pending) {
      appendAudit('command.late_result', {
        commandId: message.commandId,
        exitCode: message.exitCode
      });
      broadcastAudit();
      return;
    }

    clearTimeout(pending.timeout);
    appendAudit('command.completed', {
      commandId: message.commandId,
      deviceId: pending?.deviceId,
      exitCode: message.exitCode
    });

    if (pending?.controller?.readyState === WebSocket.OPEN) {
      send(pending.controller, message);
    }

    broadcastAudit();
    return;
  }

  if (message.type === 'screen:frame') {
    const subscribers = screenSubscribers.get(message.deviceId);

    if (!subscribers) {
      return;
    }

    for (const controller of subscribers) {
      send(controller, message);
    }
    return;
  }

  if (message.type === 'screen:error') {
    const subscribers = screenSubscribers.get(message.deviceId);

    if (!subscribers) {
      return;
    }

    for (const controller of subscribers) {
      send(controller, message);
    }
  }
}

function serializeDevices() {
  return [...devices.values()].map(({ socket: _socket, ...device }) => device);
}

function findReusableDevice(message) {
  if (message.deviceId) {
    return null;
  }

  return [...devices.values()].find((device) => (
    device.status === 'offline' &&
    device.name === (message.name || 'Unnamed device') &&
    device.os === (message.os || 'unknown')
  ));
}

function broadcastDevices() {
  broadcast({ type: 'devices', devices: serializeDevices() });
}

function broadcastAudit() {
  broadcast({ type: 'audit', entries: auditLog.slice(-100) });
}

function broadcast(message) {
  for (const controller of controllers) {
    send(controller, message);
  }
}

function subscribeControllerToScreen(controller, deviceId) {
  unsubscribeControllerFromAllScreens(controller);

  if (!screenSubscribers.has(deviceId)) {
    screenSubscribers.set(deviceId, new Set());
  }

  screenSubscribers.get(deviceId).add(controller);
}

function unsubscribeControllerFromScreen(controller, deviceId) {
  const subscribers = screenSubscribers.get(deviceId);

  if (!subscribers) {
    return;
  }

  subscribers.delete(controller);

  if (subscribers.size === 0) {
    screenSubscribers.delete(deviceId);
  }
}

function unsubscribeControllerFromAllScreens(controller) {
  for (const [deviceId, subscribers] of screenSubscribers.entries()) {
    subscribers.delete(controller);

    if (subscribers.size === 0) {
      screenSubscribers.delete(deviceId);
      const device = devices.get(deviceId);

      if (device?.socket) {
        send(device.socket, { type: 'screen:stream:stop' });
      }
    }
  }
}

function appendAudit(event, data) {
  auditLog.push({
    id: nanoid(),
    at: new Date().toISOString(),
    event,
    data
  });

  if (auditLog.length > 1_000) {
    auditLog.shift();
  }
}

function failPendingCommandsForDevice(deviceId, message) {
  for (const [commandId, pending] of pendingCommands.entries()) {
    if (pending.deviceId !== deviceId) {
      continue;
    }

    pendingCommands.delete(commandId);
    clearTimeout(pending.timeout);
    send(pending.controller, { type: 'command:error', message, commandId });
    appendAudit('command.failed', { commandId, deviceId, reason: message });
  }

  broadcastAudit();
}

function failPendingCommandsForController(controller, message) {
  for (const [commandId, pending] of pendingCommands.entries()) {
    if (pending.controller !== controller) {
      continue;
    }

    pendingCommands.delete(commandId);
    clearTimeout(pending.timeout);
    appendAudit('command.failed', { commandId, deviceId: pending.deviceId, reason: message });
  }

  broadcastAudit();
}

function getServerUrls() {
  const hosts = new Set();
  const isWildcardHost = !host || host === '0.0.0.0' || host === '::';
  const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  if (publicHost) {
    hosts.add(publicHost);
  }

  if (!isWildcardHost) {
    hosts.add(host);
  }

  if (isWildcardHost || isLocalHost) {
    hosts.add('localhost');
  }

  if (isWildcardHost) {
    for (const interfaces of Object.values(os.networkInterfaces())) {
      for (const address of interfaces || []) {
        if ((address.family === 'IPv4' || address.family === 4) && !address.internal) {
          hosts.add(address.address);
        }
      }
    }
  }

  return [...hosts].map((address) => ({
    http: `http://${address}:${port}`,
    ws: `ws://${address}:${port}/ws`
  }));
}

function redactCommandArgs(command, args) {
  if (command === 'input:typeText') {
    return ['[redacted text]'];
  }

  return args;
}

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function renderStatusPage() {
  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CMS Coordinator</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #101820;
        --panel: rgba(255, 248, 232, 0.94);
        --ink: #17222b;
        --muted: #68727c;
        --accent: #f2b84b;
        --good: #35a36a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        color: #fff3d6;
        font-family: Georgia, 'Times New Roman', serif;
        background:
          radial-gradient(circle at 10% 10%, rgba(242,184,75,.28), transparent 28rem),
          linear-gradient(135deg, #101820, #203a3a);
      }
      main { width: min(1040px, calc(100vw - 36px)); margin: 0 auto; padding: 44px 0; }
      .eyebrow { color: var(--accent); letter-spacing: .18em; text-transform: uppercase; font: 700 .78rem 'Segoe UI', sans-serif; }
      h1 { margin: 8px 0 12px; max-width: 760px; font-size: clamp(2.6rem, 7vw, 6rem); line-height: .9; letter-spacing: -.07em; }
      p { max-width: 720px; color: rgba(255,243,214,.78); font: 1rem/1.6 'Segoe UI', sans-serif; }
      .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 30px 0; }
      .card, .panel { border-radius: 26px; background: var(--panel); color: var(--ink); box-shadow: 0 24px 70px rgba(0,0,0,.28); }
      .card { padding: 22px; }
      .number { display: block; font-size: 2.5rem; font-weight: 700; }
      .label { color: var(--muted); font: .9rem 'Segoe UI', sans-serif; }
      .panel { padding: 22px; }
      h2 { margin: 0 0 14px; }
      code, pre { font-family: 'Cascadia Mono', Consolas, monospace; }
      pre { overflow: auto; padding: 16px; border-radius: 18px; color: #d9f6e8; background: #101820; }
      .ok { display: inline-flex; align-items: center; gap: 8px; }
      .ok::before { content: ''; width: 12px; height: 12px; border-radius: 999px; background: var(--good); }
      @media (max-width: 760px) { .cards { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">CMS Coordinator</div>
      <h1>Server laeuft.</h1>
      <p>Das ist die Statusseite des Coordinators. Die eigentliche Verwaltung laeuft ueber die Electron-App mit <code>npm run dev:controller</code> oder zusammen mit dem Server ueber <code>npm run dev</code>.</p>
      <section class="cards">
        <div class="card"><span id="devices" class="number">-</span><span class="label">Geraete</span></div>
        <div class="card"><span id="controllers" class="number">-</span><span class="label">Controller</span></div>
        <div class="card"><span class="number ok">OK</span><span class="label">WebSocket: /ws</span></div>
      </section>
      <section class="panel">
        <h2>Live Status</h2>
        <pre id="status">Lade Status...</pre>
      </section>
    </main>
    <script>
      async function loadStatus() {
        const response = await fetch('/api/status');
        const status = await response.json();
        document.querySelector('#devices').textContent = status.devices.length;
        document.querySelector('#controllers').textContent = status.controllers;
        document.querySelector('#status').textContent = JSON.stringify(status, null, 2);
      }
      loadStatus();
      setInterval(loadStatus, 3000);
    </script>
  </body>
</html>`;
}
