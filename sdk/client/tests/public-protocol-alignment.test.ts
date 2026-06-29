import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('scenario: SDK public protocol spec stays aligned with runtime public protocol', async () => {
  const sdkRoot = process.cwd().endsWith(join('sdk', 'client')) ? process.cwd() : join(process.cwd(), 'sdk', 'client');
  const spec = await readFile(join(sdkRoot, 'public-protocol-spec-ch.md'), 'utf8');
  const sdkFiles = await readSourceFiles(join(sdkRoot, 'src'));
  const sdkSource = sdkFiles.join('\n');

  assert.match(spec, /POST \/client\/negotiate\?tenantId=<tenantId>/);
  assert.match(spec, /session\.create\.requested/);
  assert.match(spec, /session\.created\.ack/);
  assert.match(spec, /session\.catalog\.updated/);
  assert.match(spec, /session\.status\.updated/);
  assert.match(spec, /session\.list\.requested/);
  assert.match(spec, /session\.events\.requested/);
  assert.match(spec, /session\.lease\.lost/);
  assert.doesNotMatch(spec, /GET \/client\/sessions/);
  assert.doesNotMatch(spec, /GET \/client\/session-events/);
  assert.match(spec, /sessions\.start\(\)/);
  assert.match(spec, /AgentTurn/);
  assert.match(spec, /waitForResult/);
  assert.match(spec, /turn\.completed/);
  assert.match(spec, /turn\.failed/);
  assert.match(spec, /tenant:\{tenantId\}:central:events/);
  assert.match(spec, /tenant:\{tenantId\}:clients/);
  assert.match(spec, /tenant:\{tenantId\}:client:\{clientConnectionId\}:inbox/);
  assert.match(spec, /tenant:\{tenantId\}:session:\{sessionId\}/);
  assert.doesNotMatch(spec, /client:\{principalId\}/);
  assert.match(sdkSource, /\/client\/negotiate/);
  assert.doesNotMatch(sdkSource, /\/client\/sessions/);
  assert.doesNotMatch(sdkSource, /\/client\/session-events/);
  assert.match(sdkSource, /tenantId/);
  assert.match(sdkSource, /clients/);
  assert.match(sdkSource, /session\.create\.requested/);
  assert.match(sdkSource, /session\.created\.ack/);
  assert.match(sdkSource, /session\.catalog\.updated/);
  assert.match(sdkSource, /session\.status\.updated/);
  assert.match(sdkSource, /session\.list\.requested/);
  assert.match(sdkSource, /session\.events\.requested/);
  assert.match(sdkSource, /session\.lease\.lost/);
  assert.match(sdkSource, /class SessionClient/);
  assert.match(sdkSource, /class SessionHandle/);
  assert.match(sdkSource, /class AgentTurn/);
  assert.match(sdkSource, /turn\.completed/);
  assert.match(sdkSource, /turn\.failed/);
  assert.match(sdkSource, /central:events/);

  for (const source of sdkFiles) {
    assert.doesNotMatch(source, /from ['"]\.\.\/src/);
    assert.doesNotMatch(source, /from ['"]\.\.\/\.\.\/src/);
    assert.doesNotMatch(source, /from ['"].*src\/shared/);
    assert.doesNotMatch(source, /from ['"].*src\/central/);
    assert.doesNotMatch(source, /from ['"].*src\/sidecar/);
  }
});

async function readSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return readSourceFiles(path);
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      return [await readFile(path, 'utf8')];
    }
    return [];
  }));
  return files.flat();
}