import 'dotenv/config';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const serverUrl = process.env.CMS_SERVER_URL || 'ws://localhost:4377/ws';
const connectionTimeoutMs = Number(process.env.CMS_CONNECTION_TIMEOUT_MS || 15_000);
const token = process.env.CMS_ENROLLMENT_TOKEN || 'change-this-enrollment-token';
const deviceName = process.env.CMS_DEVICE_NAME || os.hostname();
const deviceId = process.env.CMS_DEVICE_ID;
const allowScreenView = ['1', 'true', 'yes'].includes(String(process.env.CMS_ALLOW_SCREEN_VIEW || '').toLowerCase());
const allowRemoteControl = ['1', 'true', 'yes'].includes(String(process.env.CMS_ALLOW_REMOTE_CONTROL || '').toLowerCase());
const allowShell = ['1', 'true', 'yes'].includes(String(process.env.CMS_ALLOW_SHELL || '').toLowerCase());
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const allowedCommands = new Map([
  ['hostname', { file: 'hostname.exe', args: [] }],
  ['whoami', { file: 'whoami.exe', args: [] }],
  ['ipconfig', { file: 'ipconfig.exe', args: ['/all'] }],
  ['systeminfo', { file: 'systeminfo.exe', args: [] }],
  ['tasklist', { file: 'tasklist.exe', args: [] }]
]);

console.log('CMS Agent starting visibly for authorized administration.');
console.log(`Connecting to ${serverUrl} as ${deviceName}`);

let socket;
let currentDeviceId = deviceId;
let heartbeatTimer;
let reconnectTimer;
let screenStreamTimer;
let screenStreamIntervalMs = 1000;

connect();

function connect() {
  try {
    socket = new WebSocket(serverUrl, { handshakeTimeout: connectionTimeoutMs });
  } catch (error) {
    console.error(`Invalid CMS_SERVER_URL: ${error.message}`);
    scheduleReconnect();
    return;
  }

  socket.on('open', () => {
    send({
      type: 'hello',
      role: 'agent',
      token,
      deviceId: currentDeviceId,
      name: deviceName,
      os: `${os.type()} ${os.release()} ${os.arch()}`
    });
  });

  socket.on('message', async (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === 'hello:ok') {
      currentDeviceId = message.deviceId;
      console.log(`Enrolled as device ${currentDeviceId}`);
      startHeartbeat();
      return;
    }

    if (message.type === 'command:run') {
      await runAllowedCommand(message);
      return;
    }

    if (message.type === 'screen:stream:start') {
      startScreenStream(message);
      return;
    }

    if (message.type === 'screen:stream:stop') {
      stopScreenStream();
    }
  });

  socket.on('close', scheduleReconnect);
  socket.on('error', (error) => {
    console.error(`Agent connection error: ${error.message}`);
  });
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    send({ type: 'heartbeat', deviceId: currentDeviceId });
  }, 10_000);
}

function scheduleReconnect() {
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  stopScreenStream();
  reconnectTimer = setTimeout(connect, 5_000);
}

async function runAllowedCommand(message) {
  if (message.command === 'screen:snapshot') {
    await captureScreen(message);
    return;
  }

  if (message.command.startsWith('input:')) {
    await runInputCommand(message);
    return;
  }

  if (message.command === 'shell:run') {
    await runShellCommand(message);
    return;
  }

  if (message.command === 'startup:install') {
    await installStartupBatch(message);
    return;
  }

  const command = allowedCommands.get(message.command);

  if (!command) {
    send({
      type: 'command:result',
      commandId: message.commandId,
      exitCode: 126,
      stdout: '',
      stderr: `Command not allowed: ${message.command}`
    });
    return;
  }

  const startedAt = Date.now();

  try {
    const result = await runProcess(command.file, command.args);
    send({
      type: 'command:result',
      commandId: message.commandId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    send({
      type: 'command:result',
      commandId: message.commandId,
      exitCode: 1,
      stdout: '',
      stderr: error.message,
      durationMs: Date.now() - startedAt
    });
  }
}

async function runShellCommand(message) {
  const startedAt = Date.now();

  if (!allowShell) {
    sendCommandResult(message.commandId, 126, '', 'Remote shell is disabled on this agent. Set CMS_ALLOW_SHELL=1 and restart the visible agent to allow it.', startedAt);
    return;
  }

  const command = String(message.args?.[0] || '').trim();

  if (!command) {
    sendCommandResult(message.commandId, 2, '', 'No shell command was provided.', startedAt);
    return;
  }

  try {
    const result = await runProcess('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command
    ], { maxOutput: 200_000, timeout: 60_000 });

    sendCommandResult(message.commandId, result.exitCode, result.stdout, result.stderr, startedAt);
  } catch (error) {
    sendCommandResult(message.commandId, 1, '', error.message, startedAt);
  }
}

async function installStartupBatch(message) {
  const startedAt = Date.now();

  if (process.platform !== 'win32') {
    sendCommandResult(message.commandId, 126, '', 'Autostart installation is currently implemented for Windows agents only.', startedAt);
    return;
  }

  const batchPath = path.join(appRoot, 'scripts', 'enroll-agent.bat');

  if (!existsSync(batchPath)) {
    sendCommandResult(message.commandId, 1, '', `Enrollment BAT was not found at ${batchPath}.`, startedAt);
    return;
  }

  try {
    const result = await powershell([
      `$startup=[Environment]::GetFolderPath('Startup')`,
      `$shortcut=Join-Path $startup 'CMS Agent Enrollment.lnk'`,
      `$wsh=New-Object -ComObject WScript.Shell`,
      `$link=$wsh.CreateShortcut($shortcut)`,
      `$link.TargetPath='${psSingleQuoted(batchPath)}'`,
      `$link.Arguments=''`,
      `$link.WorkingDirectory='${psSingleQuoted(appRoot)}'`,
      `$link.WindowStyle=1`,
      `$link.Description='Starts the visible CMS agent enrollment script'`,
      `$link.Save()`,
      `Write-Output "Autostart shortcut created: $shortcut"`
    ], { maxOutput: 20_000, timeout: 30_000 });

    sendCommandResult(message.commandId, result.exitCode, result.stdout, result.stderr, startedAt);
  } catch (error) {
    sendCommandResult(message.commandId, 1, '', error.message, startedAt);
  }
}

async function runInputCommand(message) {
  const startedAt = Date.now();

  if (!allowRemoteControl) {
    sendCommandResult(message.commandId, 126, '', 'Remote control is disabled on this agent. Set CMS_ALLOW_REMOTE_CONTROL=1 and restart the visible agent to allow it.', startedAt);
    return;
  }

  if (process.platform !== 'win32') {
    sendCommandResult(message.commandId, 126, '', 'Remote input is currently implemented for Windows agents only.', startedAt);
    return;
  }

  const args = Array.isArray(message.args) ? message.args : [];

  try {
    if (message.command === 'input:click') {
      await mouseClick(args, 'left', 1);
      sendCommandResult(message.commandId, 0, `Clicked ${Number(args[0])},${Number(args[1])}.`, '', startedAt);
      return;
    }

    if (message.command === 'input:doubleClick') {
      await mouseClick(args, 'left', 2);
      sendCommandResult(message.commandId, 0, `Double clicked ${Number(args[0])},${Number(args[1])}.`, '', startedAt);
      return;
    }

    if (message.command === 'input:rightClick') {
      await mouseClick(args, 'right', 1);
      sendCommandResult(message.commandId, 0, `Right clicked ${Number(args[0])},${Number(args[1])}.`, '', startedAt);
      return;
    }

    if (message.command === 'input:scroll') {
      const amount = clampNumber(args[0], -2400, 2400);
      await powershell([
        user32Type(),
        `[Input.Native]::mouse_event(0x0800,0,0,${amount},0)`
      ]);
      sendCommandResult(message.commandId, 0, `Scrolled ${amount}.`, '', startedAt);
      return;
    }

    if (message.command === 'input:typeText') {
      const text = String(args[0] || '').slice(0, 4000);
      await powershell([
        'Add-Type -AssemblyName System.Windows.Forms;',
        `[System.Windows.Forms.SendKeys]::SendWait(${psString(sendKeysEscape(text))})`
      ]);
      sendCommandResult(message.commandId, 0, `Typed ${text.length} characters.`, '', startedAt);
      return;
    }

    if (message.command === 'input:hotkey') {
      const hotkey = normalizeHotkey(args[0]);
      await powershell([
        'Add-Type -AssemblyName System.Windows.Forms;',
        `[System.Windows.Forms.SendKeys]::SendWait(${psString(hotkey)})`
      ]);
      sendCommandResult(message.commandId, 0, `Sent hotkey ${String(args[0])}.`, '', startedAt);
      return;
    }

    sendCommandResult(message.commandId, 126, '', `Unsupported input command: ${message.command}`, startedAt);
  } catch (error) {
    sendCommandResult(message.commandId, 1, '', error.message, startedAt);
  }
}

async function mouseClick(args, button, count) {
  const x = clampNumber(args[0], -32768, 32767);
  const y = clampNumber(args[1], -32768, 32767);
  const down = button === 'right' ? '0x0008' : '0x0002';
  const up = button === 'right' ? '0x0010' : '0x0004';
  const clicks = [];

  for (let i = 0; i < count; i += 1) {
    clicks.push(`[Input.Native]::mouse_event(${down},0,0,0,0)`);
    clicks.push('Start-Sleep -Milliseconds 45');
    clicks.push(`[Input.Native]::mouse_event(${up},0,0,0,0)`);
  }

  await powershell([
    user32Type(),
    `[Input.Native]::SetCursorPos(${x},${y}) | Out-Null`,
    ...clicks
  ]);
}

function sendCommandResult(commandId, exitCode, stdout, stderr, startedAt) {
  send({
    type: 'command:result',
    commandId,
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt
  });
}

async function captureScreen(message) {
  const startedAt = Date.now();

  if (!allowScreenView) {
    send({
      type: 'command:result',
      commandId: message.commandId,
      exitCode: 126,
      stdout: '',
      stderr: 'Screen view is disabled on this agent. Set CMS_ALLOW_SCREEN_VIEW=1 and restart the visible agent to allow it.',
      durationMs: Date.now() - startedAt
    });
    return;
  }

  if (process.platform !== 'win32') {
    send({
      type: 'command:result',
      commandId: message.commandId,
      exitCode: 126,
      stdout: '',
      stderr: 'Screen snapshot is currently implemented for Windows agents only.',
      durationMs: Date.now() - startedAt
    });
    return;
  }

  try {
    const frame = await captureScreenFrame();
    send({
      type: 'command:result',
      commandId: message.commandId,
      exitCode: 0,
      stdout: 'Screen snapshot captured.',
      stderr: '',
      durationMs: Date.now() - startedAt,
      width: frame.width,
      height: frame.height,
      screenshotDataUrl: frame.screenshotDataUrl
    });
  } catch (error) {
    send({
      type: 'command:result',
      commandId: message.commandId,
      exitCode: 1,
      stdout: '',
      stderr: error.message,
      durationMs: Date.now() - startedAt
    });
  }
}

function startScreenStream(message) {
  stopScreenStream();

  if (!allowScreenView) {
    send({
      type: 'screen:error',
      deviceId: currentDeviceId,
      message: 'Screen view is disabled on this agent. Set CMS_ALLOW_SCREEN_VIEW=1 and restart the visible agent to allow it.'
    });
    return;
  }

  const fps = clampNumber(message.fps || 1, 1, 4);
  screenStreamIntervalMs = Math.round(1000 / fps);

  console.log(`Live screen stream started at ${fps} fps.`);
  screenStreamTimer = setTimeout(streamScreenFrame, 0);
}

function stopScreenStream() {
  if (screenStreamTimer) {
    console.log('Live screen stream stopped.');
  }

  clearTimeout(screenStreamTimer);
  screenStreamTimer = null;
}

async function streamScreenFrame() {
  await sendScreenFrame();

  if (screenStreamTimer !== null) {
    screenStreamTimer = setTimeout(streamScreenFrame, screenStreamIntervalMs);
  }
}

async function sendScreenFrame() {
  try {
    const frame = await captureScreenFrame();
    send({
      type: 'screen:frame',
      deviceId: currentDeviceId,
      capturedAt: new Date().toISOString(),
      ...frame
    });
  } catch (error) {
    send({
      type: 'screen:error',
      deviceId: currentDeviceId,
      message: error.message
    });
    stopScreenStream();
  }
}

async function captureScreenFrame() {
  if (process.platform !== 'win32') {
    throw new Error('Screen capture is currently implemented for Windows agents only.');
  }

  const result = await runProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
      '$bounds=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;',
      '$bmp=New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height;',
      '$gfx=[System.Drawing.Graphics]::FromImage($bmp);',
      '$gfx.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size);',
      '$ms=New-Object System.IO.MemoryStream;',
      '$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Jpeg);',
      '$gfx.Dispose();$bmp.Dispose();',
      '[Console]::WriteLine(($bounds.X.ToString()+\",\"+$bounds.Y.ToString()+\",\"+$bounds.Width.ToString()+\",\"+$bounds.Height.ToString()+\",\"+[Convert]::ToBase64String($ms.ToArray())))'
    ].join('')
  ], { maxOutput: 20_000_000, timeout: 15_000 });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Screen capture failed.');
  }

  const [offsetX, offsetY, width, height, base64] = result.stdout.trim().split(',', 5);

  if (!base64) {
    throw new Error('Screen capture returned no image data.');
  }

  return {
    offsetX: Number(offsetX),
    offsetY: Number(offsetY),
    width: Number(width),
    height: Number(height),
    screenshotDataUrl: `data:image/jpeg;base64,${base64}`
  };
}

function runProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: false,
      shell: false,
      timeout: options.timeout ?? 30_000
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (exitCode) => {
      const maxOutput = options.maxOutput ?? 64_000;
      resolve({
        exitCode,
        stdout: stdout.slice(0, maxOutput),
        stderr: stderr.slice(0, maxOutput)
      });
    });
  });
}

function powershell(commands, options = {}) {
  return runProcess('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    commands.join(';')
  ], options);
}

function user32Type() {
  return 'Add-Type -Namespace Input -Name Native -MemberDefinition "[DllImport(`\"user32.dll`\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(`\"user32.dll`\")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);"';
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.min(Math.max(Math.round(number), min), max);
}

function psString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function psSingleQuoted(value) {
  return String(value).replaceAll("'", "''");
}

function sendKeysEscape(value) {
  return String(value).replace(/[+^%~()[\]{}]/g, '{$&}');
}

function normalizeHotkey(value) {
  const hotkeys = new Map([
    ['ctrl+c', '^c'],
    ['ctrl+v', '^v'],
    ['ctrl+a', '^a'],
    ['alt+tab', '%{TAB}'],
    ['win+r', '^{ESC}r'],
    ['ctrl+shift+esc', '^+{ESC}'],
    ['alt+f4', '%{F4}'],
    ['enter', '{ENTER}'],
    ['escape', '{ESC}']
  ]);

  return hotkeys.get(String(value || '').toLowerCase()) || '{ESC}';
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
