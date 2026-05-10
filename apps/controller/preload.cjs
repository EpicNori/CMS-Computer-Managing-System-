const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cms', {
  listDevices: () => ipcRenderer.invoke('devices:list'),
  runCommand: (payload) => ipcRenderer.invoke('command:run', payload),
  startScreenStream: (payload) => ipcRenderer.invoke('screen:stream:start', payload),
  stopScreenStream: (payload) => ipcRenderer.invoke('screen:stream:stop', payload),
  onConnection: (callback) => {
    ipcRenderer.on('connection', (_event, payload) => callback(payload));
  },
  onMessage: (callback) => {
    ipcRenderer.on('message', (_event, payload) => callback(payload));
  }
});
