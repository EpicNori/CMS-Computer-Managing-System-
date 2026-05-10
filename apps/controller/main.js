import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverUrl = process.env.CMS_SERVER_URL || 'ws://localhost:4377/ws';
const adminToken = process.env.CMS_ADMIN_TOKEN || 'change-this-admin-token';

let window;
let socket;

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
  socket = new WebSocket(serverUrl);

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
    emit('connection', { status: 'offline', serverUrl });
    setTimeout(connect, 5_000);
  });

  socket.on('error', (error) => {
    emit('connection', { status: 'error', serverUrl, message: error.message });
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function emit(channel, payload) {
  window?.webContents.send(channel, payload);
}
