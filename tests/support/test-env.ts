import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadTestEnv(): Record<string, string> {
  const path = join(process.cwd(), 'tests', '.env');
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const separatorIndex = line.indexOf('=');
          return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)] as const;
        })
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export function isCredentialUnavailable(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.includes('CredentialUnavailable')
    || text.includes('DefaultAzureCredential')
    || text.includes('Azure CLI')
    || text.includes('az login')
    || text.includes('No credential');
}