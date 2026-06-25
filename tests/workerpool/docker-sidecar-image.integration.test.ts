import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);
const IMAGE_NAME = 'agent-runtime-sidecar-poc:test';

test('scenario: docker sidecar image can use mounted Azure CLI auth on Windows host', async (context) => {
  if (process.env.RUN_DOCKER_WORKERPOOL_E2E !== '1') {
    context.skip('set RUN_DOCKER_WORKERPOOL_E2E=1 to run Docker WorkerPool image validation');
    return;
  }
  if (!await isDockerAvailable()) {
    context.skip('Docker is unavailable');
    return;
  }
  const azureConfigDir = resolve(process.env.AZURE_CONFIG_DIR_HOST ?? join(homedir(), '.azure'));
  if (!existsSync(azureConfigDir)) {
    context.skip(`Azure CLI profile directory not found: ${azureConfigDir}`);
    return;
  }

  await execFileAsync('docker', ['build', '-f', 'containers/sidecar/Dockerfile', '-t', IMAGE_NAME, '.'], { maxBuffer: 30 * 1024 * 1024 });
  const script = [
    'set -e',
    'az account show --output none',
    'az account get-access-token --scope https://cognitiveservices.azure.com/.default --output none',
    'node -e "const { DefaultAzureCredential } = require(\'@azure/identity\'); new DefaultAzureCredential().getToken(\'https://cognitiveservices.azure.com/.default\').then((token) => { if (!token || !token.token) throw new Error(\'missing token\'); console.log(\'token ok\'); })"'
  ].join(' && ');

  const { stdout } = await execFileAsync('docker', [
    'run',
    '--rm',
    '-e', 'AZURE_CONFIG_DIR=/home/sidecar/.azure',
    '-v', `${azureConfigDir}:/home/sidecar/.azure`,
    IMAGE_NAME,
    'bash', '-lc', script
  ], { maxBuffer: 10 * 1024 * 1024 });

  assert.match(stdout, /token ok/);
});

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}