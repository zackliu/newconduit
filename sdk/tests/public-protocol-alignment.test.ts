import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

test('scenario: SDK public protocol spec stays aligned with runtime public protocol', async () => {
  const sdkRoot = process.cwd().endsWith('sdk') ? process.cwd() : join(process.cwd(), 'sdk');
  const spec = await readFile(join(sdkRoot, 'public-protocol-spec-ch.md'), 'utf8');
  const sdkFiles = await readSourceFiles(join(sdkRoot, 'src'));
  const sdkSource = sdkFiles.join('\n');

  assert.match(spec, /POST \/client\/negotiate\?tenantId=<tenantId>/);
  assert.match(spec, /session\.create\.requested/);
  assert.match(spec, /sessions\.start\(\)/);
  assert.match(spec, /AgentTurn/);
  assert.match(spec, /waitForResult/);
  assert.match(spec, /tenant:\{tenantId\}:central:events/);
  assert.match(spec, /tenant:\{tenantId\}:session:\{sessionId\}/);
  assert.match(sdkSource, /\/client\/negotiate/);
  assert.match(sdkSource, /tenantId/);
  assert.match(sdkSource, /session\.create\.requested/);
  assert.match(sdkSource, /class SessionClient/);
  assert.match(sdkSource, /class SessionHandle/);
  assert.match(sdkSource, /class AgentTurn/);
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