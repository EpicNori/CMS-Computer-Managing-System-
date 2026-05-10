import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';

const adminToken = 'test-admin-token';
const enrollmentToken = 'test-enrollment-token';

test('coordinator authenticates clients, routes commands, times out, and forwards screen frames', async () => {
  const port = await getFreePort();
  const serverProcess = await startServer(port, {
    CMS_COMMAND_TIMEOUT_MS: '250'
  });
  const sockets = [];

  try {
    const controller = await connectClient(port, {
      type: 'hello',
      role: 'controller',
      token: adminToken
    });
    sockets.push(controller);

    const agent = await connectClient(port, {
      type: 'hello',
      role: 'agent',
      token: enrollmentToken,
      name: 'Integration Agent',
      os: 'Test OS'
    });
    sockets.push(agent);

    const deviceId = agent.authMessage.deviceId;
    assert.ok(deviceId);

    const devices = await waitForMessage(controller, (message) => (
      message.type === 'devices' &&
      message.devices.some((device) => device.id === deviceId && device.status === 'online')
    ));
    assert.equal(devices.devices.find((device) => device.id === deviceId).name, 'Integration Agent');

    const routedCommandPromise = waitForMessage(agent, (message) => message.type === 'command:run' && message.command === 'hostname');
    controller.send(JSON.stringify({
      type: 'command:run',
      deviceId,
      command: 'hostname',
      args: []
    }));

    const routedCommand = await routedCommandPromise;
    const commandResultPromise = waitForMessage(controller, (message) => message.type === 'command:result' && message.commandId === routedCommand.commandId);
    agent.send(JSON.stringify({
      type: 'command:result',
      commandId: routedCommand.commandId,
      exitCode: 0,
      stdout: 'integration-host',
      stderr: '',
      durationMs: 1
    }));

    const commandResult = await commandResultPromise;
    assert.equal(commandResult.stdout, 'integration-host');

    const timedOutCommandPromise = waitForMessage(agent, (message) => message.type === 'command:run' && message.command === 'whoami');
    controller.send(JSON.stringify({
      type: 'command:run',
      deviceId,
      command: 'whoami',
      args: []
    }));

    const timedOutCommand = await timedOutCommandPromise;
    const timeout = await waitForMessage(controller, (message) => message.type === 'command:error' && message.commandId === timedOutCommand.commandId, 2_000);
    assert.match(timeout.message, /timed out/i);

    const streamStartPromise = waitForMessage(agent, (message) => message.type === 'screen:stream:start');
    controller.send(JSON.stringify({
      type: 'screen:stream:start',
      deviceId,
      fps: 2
    }));

    const streamStart = await streamStartPromise;
    assert.equal(streamStart.fps, 2);

    const framePromise = waitForMessage(controller, (message) => message.type === 'screen:frame' && message.deviceId === deviceId);
    agent.send(JSON.stringify({
      type: 'screen:frame',
      deviceId,
      width: 800,
      height: 600,
      offsetX: 10,
      offsetY: 20,
      screenshotDataUrl: 'data:image/jpeg;base64,abc'
    }));

    const frame = await framePromise;
    assert.equal(frame.offsetX, 10);
    assert.equal(frame.offsetY, 20);
  } finally {
    closeSockets(sockets);
    serverProcess.kill();
  }
});

test('coordinator rejects invalid tokens and reports local-only URLs correctly', async () => {
  const port = await getFreePort();
  const serverProcess = await startServer(port, {
    CMS_SERVER_HOST: '127.0.0.1'
  });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    const status = await response.json();
    assert.deepEqual(status.listen, { host: '127.0.0.1', port });
    assert.ok(status.urls.some((url) => url.ws === `ws://127.0.0.1:${port}/ws`));
    assert.ok(status.urls.some((url) => url.ws === `ws://localhost:${port}/ws`));

    const rejected = await connectClient(port, {
      type: 'hello',
      role: 'controller',
      token: 'wrong-token'
    }, { expectClose: true });

    assert.equal(rejected.errorMessage, 'Invalid admin token.');
  } finally {
    serverProcess.kill();
  }
});

test('coordinator rejects command results from the wrong agent socket', async () => {
  const port = await getFreePort();
  const serverProcess = await startServer(port);
  const sockets = [];

  try {
    const controller = await connectClient(port, {
      type: 'hello',
      role: 'controller',
      token: adminToken
    });
    sockets.push(controller);

    const targetAgent = await connectClient(port, {
      type: 'hello',
      role: 'agent',
      token: enrollmentToken,
      name: 'Target Agent',
      os: 'Test OS'
    });
    sockets.push(targetAgent);

    const otherAgent = await connectClient(port, {
      type: 'hello',
      role: 'agent',
      token: enrollmentToken,
      name: 'Other Agent',
      os: 'Test OS'
    });
    sockets.push(otherAgent);

    const commandPromise = waitForMessage(targetAgent, (message) => message.type === 'command:run' && message.command === 'hostname');
    controller.send(JSON.stringify({
      type: 'command:run',
      deviceId: targetAgent.authMessage.deviceId,
      command: 'hostname',
      args: []
    }));
    const command = await commandPromise;

    otherAgent.send(JSON.stringify({
      type: 'command:result',
      commandId: command.commandId,
      exitCode: 0,
      stdout: 'spoofed',
      stderr: ''
    }));

    const rejectionAudit = await waitForMessage(controller, (message) => (
      message.type === 'audit' &&
      message.entries.some((entry) => entry.event === 'command.rejected_result')
    ));
    assert.ok(rejectionAudit.entries.some((entry) => entry.data.expectedDeviceId === targetAgent.authMessage.deviceId));

    const resultPromise = waitForMessage(controller, (message) => message.type === 'command:result' && message.commandId === command.commandId);
    targetAgent.send(JSON.stringify({
      type: 'command:result',
      commandId: command.commandId,
      exitCode: 0,
      stdout: 'real',
      stderr: ''
    }));

    const result = await resultPromise;
    assert.equal(result.stdout, 'real');
  } finally {
    closeSockets(sockets);
    serverProcess.kill();
  }
});

test('real agent connects and executes allowlisted commands', { skip: process.platform !== 'win32' }, async () => {
  const port = await getFreePort();
  const serverProcess = await startServer(port);
  let agentProcess;
  const sockets = [];

  try {
    const controller = await connectClient(port, {
      type: 'hello',
      role: 'controller',
      token: adminToken
    });
    sockets.push(controller);

    agentProcess = spawn(process.execPath, ['apps/agent/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CMS_SERVER_URL: `ws://127.0.0.1:${port}/ws`,
        CMS_ENROLLMENT_TOKEN: enrollmentToken,
        CMS_DEVICE_NAME: 'Real Agent Test',
        CMS_ALLOW_SCREEN_VIEW: '0',
        CMS_ALLOW_REMOTE_CONTROL: '0',
        CMS_ALLOW_SHELL: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const devices = await waitForMessage(controller, (message) => (
      message.type === 'devices' &&
      message.devices.some((device) => device.name === 'Real Agent Test' && device.status === 'online')
    ), 5_000);
    const device = devices.devices.find((entry) => entry.name === 'Real Agent Test');

    controller.send(JSON.stringify({
      type: 'command:run',
      deviceId: device.id,
      command: 'hostname',
      args: []
    }));

    const result = await waitForMessage(controller, (message) => message.type === 'command:result', 5_000);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.trim().length > 0);
  } finally {
    closeSockets(sockets);
    agentProcess?.kill();
    serverProcess.kill();
  }
});

async function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['apps/server/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CMS_SERVER_PORT: String(port),
      CMS_SERVER_HOST: extraEnv.CMS_SERVER_HOST || '127.0.0.1',
      CMS_ADMIN_TOKEN: adminToken,
      CMS_ENROLLMENT_TOKEN: enrollmentToken,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(100);
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with ${child.exitCode}: ${output}`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return child;
      }
    } catch {
      // Keep waiting for the server to bind.
    }
  }

  child.kill();
  throw new Error(`Server did not start: ${output}`);
}

function connectClient(port, hello, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let errorMessage = '';
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out connecting ${hello.role}`));
    }, 2_000);

    socket.on('open', () => {
      socket.send(JSON.stringify(hello));
    });

    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'error') {
        errorMessage = message.message;
      }

      if (!options.expectClose && message.type === 'hello:ok') {
        clearTimeout(timeout);
        socket.authMessage = message;
        resolve(socket);
      }
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      if (options.expectClose) {
        resolve({ errorMessage });
        return;
      }

      reject(new Error(`Socket closed before auth completed for ${hello.role}: ${errorMessage}`));
    });

    socket.on('error', reject);
  });
}

function closeSockets(sockets) {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
}

function waitForMessage(socket, predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for WebSocket message.'));
    }, timeoutMs);

    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      socket.off('message', onMessage);
    }

    socket.on('message', onMessage);
  });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
