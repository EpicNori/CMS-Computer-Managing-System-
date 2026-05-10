const state = {
  devices: [],
  selectedDeviceId: null,
  audit: [],
  lastScreen: null,
  streamActive: false,
  pointer: { x: 0, y: 0 }
};

const elements = {
  devices: document.querySelector('#devices'),
  selectedDevice: document.querySelector('#selected-device'),
  command: document.querySelector('#command'),
  output: document.querySelector('#output'),
  audit: document.querySelector('#audit'),
  refresh: document.querySelector('#refresh'),
  runCommand: document.querySelector('#run-command'),
  runShell: document.querySelector('#run-shell'),
  controlActions: document.querySelectorAll('.control-action'),
  inputActions: document.querySelectorAll('.input-action'),
  startStream: document.querySelector('#start-stream'),
  stopStream: document.querySelector('#stop-stream'),
  textInput: document.querySelector('#text-input'),
  shellCommand: document.querySelector('#shell-command'),
  sendText: document.querySelector('#send-text'),
  hotkey: document.querySelector('#hotkey'),
  sendHotkey: document.querySelector('#send-hotkey'),
  screenViewer: document.querySelector('#screen-viewer'),
  screenImage: document.querySelector('#screen-image'),
  screenCursor: document.querySelector('#screen-cursor'),
  screenMeta: document.querySelector('#screen-meta'),
  connectionDot: document.querySelector('#connection-dot'),
  connectionStatus: document.querySelector('#connection-status'),
  connectionUrl: document.querySelector('#connection-url'),
  metricDevices: document.querySelector('#metric-devices'),
  metricOnline: document.querySelector('#metric-online'),
  metricAudit: document.querySelector('#metric-audit')
};

window.cms.onConnection((connection) => {
  elements.connectionDot.className = `dot ${connection.status}`;
  elements.connectionStatus.textContent = connection.status;
  elements.connectionUrl.textContent = connection.message || connection.serverUrl;
});

window.cms.onMessage((message) => {
  if (message.type === 'devices') {
    state.devices = message.devices;
    renderDevices();
    renderMetrics();
    return;
  }

  if (message.type === 'audit') {
    state.audit = message.entries;
    renderAudit();
    renderMetrics();
    return;
  }

  if (message.type === 'screen:frame') {
    if (message.deviceId !== state.selectedDeviceId) {
      return;
    }

    renderScreenFrame(message);
    return;
  }

  if (message.type === 'screen:error') {
    elements.output.textContent = message.message;
    elements.screenMeta.textContent = 'Stream Fehler';
    state.streamActive = false;
    renderSessionState();
    return;
  }

  if (message.type === 'command:result') {
    if (message.screenshotDataUrl) {
      renderScreenFrame({
        width: message.width,
        height: message.height,
        screenshotDataUrl: message.screenshotDataUrl,
        capturedAt: new Date().toISOString()
      });
    }

    elements.output.textContent = [
      `Exit Code: ${message.exitCode}`,
      `Duration: ${message.durationMs ?? 'unknown'} ms`,
      '',
      'STDOUT:',
      message.stdout || '(empty)',
      '',
      'STDERR:',
      message.stderr || '(empty)'
    ].join('\n');
  }

  if (message.type === 'command:error' || message.type === 'error') {
    elements.output.textContent = message.message;
  }
});

elements.refresh.addEventListener('click', () => {
  window.cms.listDevices();
});

elements.runCommand.addEventListener('click', () => {
  runSelectedCommand(elements.command.value);
});

for (const action of elements.controlActions) {
  action.addEventListener('click', () => {
    const command = action.dataset.command;
    elements.command.value = command;
    runSelectedCommand(command);
  });
}

for (const action of elements.inputActions) {
  action.addEventListener('click', () => {
    runInputAction(action.dataset.input);
  });
}

elements.startStream.addEventListener('click', () => {
  if (!state.selectedDeviceId) {
    elements.output.textContent = 'Bitte zuerst ein Geraet auswaehlen.';
    return;
  }

  state.streamActive = true;
  renderSessionState();
  elements.screenMeta.textContent = 'Stream startet...';
  window.cms.startScreenStream({ deviceId: state.selectedDeviceId, fps: 2 });
});

elements.stopStream.addEventListener('click', () => {
  stopScreenStream();
});

elements.screenImage.addEventListener('click', (event) => {
  const point = imagePointToScreenPoint(event);
  if (!point) {
    return;
  }

  state.pointer = point;
  positionCursor(point);
  runSelectedCommand('input:click', { args: [point.x, point.y] });
});

elements.screenImage.addEventListener('mousemove', (event) => {
  const point = imagePointToScreenPoint(event);
  if (point && state.lastScreen) {
    elements.screenMeta.textContent = `${new Date().toLocaleTimeString()} - ${state.lastScreen.width}x${state.lastScreen.height} - ${point.x},${point.y}`;
  }
});

elements.sendText.addEventListener('click', () => {
  const text = elements.textInput.value;
  if (!text) {
    elements.output.textContent = 'Kein Text eingegeben.';
    return;
  }

  runSelectedCommand('input:typeText', { args: [text] });
});

elements.sendHotkey.addEventListener('click', () => {
  runSelectedCommand('input:hotkey', { args: [elements.hotkey.value] });
});

elements.runShell.addEventListener('click', () => {
  const command = elements.shellCommand.value.trim();

  if (!command) {
    elements.output.textContent = 'Kein Shell-Command eingegeben.';
    return;
  }

  runSelectedCommand('shell:run', { args: [command] });
});

function stopScreenStream() {
  if (state.selectedDeviceId) {
    window.cms.stopScreenStream({ deviceId: state.selectedDeviceId });
  }

  state.streamActive = false;
  elements.screenMeta.textContent = state.lastScreen ? 'Stream gestoppt' : 'Kein Stream';
  renderSessionState();
}

function runInputAction(action) {
  const { x, y } = state.pointer;

  if (action === 'click') {
    runSelectedCommand('input:click', { args: [x, y] });
    return;
  }

  if (action === 'doubleClick') {
    runSelectedCommand('input:doubleClick', { args: [x, y] });
    return;
  }

  if (action === 'rightClick') {
    runSelectedCommand('input:rightClick', { args: [x, y] });
    return;
  }

  if (action === 'scrollUp') {
    runSelectedCommand('input:scroll', { args: [480] });
    return;
  }

  if (action === 'scrollDown') {
    runSelectedCommand('input:scroll', { args: [-480] });
  }
}

function runSelectedCommand(command, options = {}) {
  if (!state.selectedDeviceId) {
    elements.output.textContent = 'Bitte zuerst ein Geraet auswaehlen.';
    return;
  }

  if (!options.quiet) {
    elements.output.textContent = `${command} laeuft...`;
  }

  window.cms.runCommand({
    deviceId: state.selectedDeviceId,
    command,
    args: options.args || []
  });
}

function renderScreenFrame(frame) {
  state.lastScreen = {
    width: frame.width,
    height: frame.height
  };
  elements.screenImage.src = frame.screenshotDataUrl;
  elements.screenMeta.textContent = `${new Date(frame.capturedAt || Date.now()).toLocaleTimeString()} - ${frame.width}x${frame.height}`;
}

function imagePointToScreenPoint(event) {
  if (!state.lastScreen) {
    elements.output.textContent = 'Erst Screen aktualisieren, dann klicken.';
    return null;
  }

  const rect = elements.screenImage.getBoundingClientRect();
  const x = Math.round(((event.clientX - rect.left) / rect.width) * state.lastScreen.width);
  const y = Math.round(((event.clientY - rect.top) / rect.height) * state.lastScreen.height);

  return {
    x: clamp(x, 0, state.lastScreen.width - 1),
    y: clamp(y, 0, state.lastScreen.height - 1)
  };
}

function positionCursor(point) {
  const rect = elements.screenImage.getBoundingClientRect();
  const x = (point.x / state.lastScreen.width) * rect.width;
  const y = (point.y / state.lastScreen.height) * rect.height;
  elements.screenCursor.classList.remove('hidden');
  elements.screenCursor.style.left = `${x}px`;
  elements.screenCursor.style.top = `${y}px`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function renderDevices() {
  elements.devices.innerHTML = '';

  if (state.devices.length === 0) {
    elements.devices.innerHTML = '<div class="empty">Noch keine Geraete verbunden.</div>';
    return;
  }

  for (const device of state.devices) {
    const item = document.createElement('button');
    item.className = `device ${device.id === state.selectedDeviceId ? 'selected' : ''}`;
    item.innerHTML = `
      <span class="device-name">${escapeHtml(device.name)}</span>
      <span class="device-meta">${escapeHtml(device.os)}</span>
      <span class="device-footer">
        <span class="pill ${device.status}">${escapeHtml(device.status)}</span>
        <span>${new Date(device.lastSeen).toLocaleString()}</span>
      </span>
    `;
    item.addEventListener('click', () => {
      if (state.streamActive && state.selectedDeviceId !== device.id) {
        stopScreenStream();
      }

      state.selectedDeviceId = device.id;
      elements.selectedDevice.textContent = device.name;
      elements.screenCursor.classList.add('hidden');
      renderDevices();
      renderSessionState();
    });
    elements.devices.appendChild(item);
  }
}

function renderMetrics() {
  elements.metricDevices.textContent = state.devices.length;
  elements.metricOnline.textContent = state.devices.filter((device) => device.status === 'online').length;
  elements.metricAudit.textContent = state.audit.length;
}

function renderSessionState() {
  const hasDevice = Boolean(state.selectedDeviceId);
  elements.startStream.disabled = !hasDevice || state.streamActive;
  elements.stopStream.disabled = !hasDevice || !state.streamActive;
}

function renderAudit() {
  elements.audit.innerHTML = '';

  for (const entry of state.audit.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'audit-row';
    row.innerHTML = `
      <span>${new Date(entry.at).toLocaleTimeString()}</span>
      <strong>${escapeHtml(entry.event)}</strong>
      <code>${escapeHtml(JSON.stringify(entry.data))}</code>
    `;
    elements.audit.appendChild(row);
  }
}

renderMetrics();
renderSessionState();

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
