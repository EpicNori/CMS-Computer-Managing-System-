const state = {
  devices: [],
  selectedDeviceId: null,
  audit: [],
  lastScreen: null,
  streamActive: false,
  inputLocked: true,
  pointer: null
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
  inputLock: document.querySelector('#input-lock'),
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
        offsetX: message.offsetX,
        offsetY: message.offsetY,
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

elements.inputLock.addEventListener('change', () => {
  state.inputLocked = elements.inputLock.checked;
  renderInputLockState();
  elements.output.textContent = state.inputLocked
    ? 'Remote Input ist gesperrt.'
    : 'Remote Input ist entsperrt.';
});

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
  if (isInputLocked()) {
    return;
  }

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
  if (isInputLocked()) {
    return;
  }

  const text = elements.textInput.value;
  if (!text) {
    elements.output.textContent = 'Kein Text eingegeben.';
    return;
  }

  runSelectedCommand('input:typeText', { args: [text] });
});

elements.sendHotkey.addEventListener('click', () => {
  if (isInputLocked()) {
    return;
  }

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
  if (isInputLocked()) {
    return;
  }

  if (!state.pointer) {
    elements.output.textContent = 'Bitte zuerst im Live Screen einen Punkt auswaehlen.';
    return;
  }

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

function isInputLocked() {
  if (!state.inputLocked) {
    return false;
  }

  elements.output.textContent = 'Remote Input ist gesperrt. Entsperre ihn zuerst.';
  return true;
}

function renderScreenFrame(frame) {
  state.lastScreen = {
    width: frame.width,
    height: frame.height,
    offsetX: frame.offsetX || 0,
    offsetY: frame.offsetY || 0
  };
  elements.screenImage.src = frame.screenshotDataUrl;
  elements.screenMeta.textContent = `${new Date(frame.capturedAt || Date.now()).toLocaleTimeString()} - ${frame.width}x${frame.height} @ ${state.lastScreen.offsetX},${state.lastScreen.offsetY}`;
}

function imagePointToScreenPoint(event) {
  if (!state.lastScreen) {
    elements.output.textContent = 'Erst Screen aktualisieren, dann klicken.';
    return null;
  }

  const imageRect = getRenderedImageRect();

  if (
    event.clientX < imageRect.left ||
    event.clientX > imageRect.right ||
    event.clientY < imageRect.top ||
    event.clientY > imageRect.bottom
  ) {
    return null;
  }

  const relativeX = Math.round(((event.clientX - imageRect.left) / imageRect.width) * state.lastScreen.width);
  const relativeY = Math.round(((event.clientY - imageRect.top) / imageRect.height) * state.lastScreen.height);

  return {
    x: state.lastScreen.offsetX + clamp(relativeX, 0, state.lastScreen.width - 1),
    y: state.lastScreen.offsetY + clamp(relativeY, 0, state.lastScreen.height - 1)
  };
}

function positionCursor(point) {
  const imageRect = getRenderedImageRect();
  const stageRect = elements.screenImage.parentElement.getBoundingClientRect();
  const relativeX = point.x - state.lastScreen.offsetX;
  const relativeY = point.y - state.lastScreen.offsetY;
  const x = imageRect.left - stageRect.left + (relativeX / state.lastScreen.width) * imageRect.width;
  const y = imageRect.top - stageRect.top + (relativeY / state.lastScreen.height) * imageRect.height;
  elements.screenCursor.classList.remove('hidden');
  elements.screenCursor.style.left = `${x}px`;
  elements.screenCursor.style.top = `${y}px`;
}

function getRenderedImageRect() {
  const rect = elements.screenImage.getBoundingClientRect();

  if (!state.lastScreen || rect.width === 0 || rect.height === 0) {
    return rect;
  }

  const naturalRatio = state.lastScreen.width / state.lastScreen.height;
  const elementRatio = rect.width / rect.height;
  let width = rect.width;
  let height = rect.height;
  let left = rect.left;
  let top = rect.top;

  if (elementRatio > naturalRatio) {
    width = rect.height * naturalRatio;
    left = rect.left + (rect.width - width) / 2;
  } else {
    height = rect.width / naturalRatio;
    top = rect.top + (rect.height - height) / 2;
  }

  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height
  };
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
      state.lastScreen = null;
      state.pointer = null;
      elements.selectedDevice.textContent = device.name;
      elements.screenImage.removeAttribute('src');
      elements.screenMeta.textContent = 'Kein Stream';
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
  renderInputLockState();
}

function renderInputLockState() {
  elements.inputLock.checked = state.inputLocked;
  elements.screenViewer.classList.toggle('input-locked', state.inputLocked);

  for (const action of elements.inputActions) {
    action.disabled = state.inputLocked;
  }

  elements.sendText.disabled = state.inputLocked;
  elements.sendHotkey.disabled = state.inputLocked;
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
renderInputLockState();

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
