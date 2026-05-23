import 'dotenv/config';
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverUrl = process.env.CMS_SERVER_URL || 'ws://localhost:4377/ws';
const connectionTimeoutMs = Number(process.env.CMS_CONNECTION_TIMEOUT_MS || 15_000);
const adminToken = readRequiredSecret('CMS_ADMIN_TOKEN', 'change-this-cms-token');

let window;
let socket;
let reconnectTimer;

app.whenReady().then(() => {
  window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: '#101820',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  connect();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('devices:list', () => {
  send({ type: 'devices:list' });
});

ipcMain.handle('command:run', (_event, payload) => {
  send({ type: 'command:run', ...payload });
});

ipcMain.handle('screen:stream:start', (_event, payload) => {
  send({ type: 'screen:stream:start', ...payload });
});

ipcMain.handle('screen:stream:stop', (_event, payload) => {
  send({ type: 'screen:stream:stop', ...payload });
});

function connect() {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
    return;
  }

  clearTimeout(reconnectTimer);
  try {
    socket = new WebSocket(serverUrl, { handshakeTimeout: connectionTimeoutMs });
  } catch (error) {
    socket = null;
    emit('connection', { status: 'error', serverUrl, message: `Invalid CMS_SERVER_URL: ${error.message}` });
    scheduleReconnect();
    return;
  }

  socket.on('open', () => {
    send({ type: 'hello', role: 'controller', token: adminToken });
    emit('connection', { status: 'online', serverUrl });
  });

  socket.on('message', (raw) => {
    try {
      emit('message', JSON.parse(raw.toString()));
    } catch {
      emit('message', { type: 'error', message: 'Invalid server message.' });
    }
  });

  socket.on('close', () => {
    socket = null;
    emit('connection', { status: 'offline', serverUrl });
    scheduleReconnect();
  });

  socket.on('error', (error) => {
    emit('connection', { status: 'error', serverUrl, message: error.message });
  });
}

function readRequiredSecret(name, insecureDefault) {
  const value = process.env[name];
  if (value && value !== insecureDefault) {
    return value;
  }

  if (isEnabled(process.env.CMS_ALLOW_INSECURE_DEFAULT_TOKENS)) {
    return insecureDefault;
  }

  throw new Error(`${name} must be set to a non-default value. Set CMS_ALLOW_INSECURE_DEFAULT_TOKENS=1 only for local demos.`);
}

function isEnabled(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return;
  }

  emit('message', { type: 'error', message: 'Controller is not connected to the CMS server yet.' });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5_000);
}

function emit(channel, payload) {
  window?.webContents.send(channel, payload);
}
