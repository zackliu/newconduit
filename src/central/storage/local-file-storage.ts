import { appendFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RuntimeEvent, RuntimeStorage, SessionRecord, WorkerRecord, WorkspaceSnapshot } from '../../shared';

export class LocalFileStorage implements RuntimeStorage {
  constructor(private readonly root: string) {}

  async writeSession(session: SessionRecord): Promise<void> {
    await this.writeJson(join(this.root, 'sessions', session.sessionId, 'session.json'), session);
  }

  async readSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.readJson(join(this.root, 'sessions', sessionId, 'session.json'));
  }

  async appendEvent(event: RuntimeEvent): Promise<RuntimeEvent> {
    if (!event.sessionId) {
      throw new Error('sessionId is required for session event append');
    }
    const path = join(this.root, 'sessions', event.sessionId, 'events.jsonl');
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  async readEvents(sessionId: string, afterSequence: number): Promise<RuntimeEvent[]> {
    const text = await this.readText(join(this.root, 'sessions', sessionId, 'events.jsonl'));
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as RuntimeEvent).filter((event) => event.sequence > afterSequence);
  }

  async writeWorker(worker: WorkerRecord): Promise<void> {
    await this.writeJson(join(this.root, 'workers', `${worker.workerId}.json`), worker);
  }

  async readWorkers(): Promise<WorkerRecord[]> {
    const directory = join(this.root, 'workers');
    try {
      const files = await readdir(directory);
      const workers = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => this.readJson<WorkerRecord>(join(directory, file))));
      return workers.filter((worker): worker is WorkerRecord => worker !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async writeSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    await this.writeJson(join(snapshot.storageLocation, 'snapshot.json'), snapshot);
  }

  async readSnapshot(sessionId: string, snapshotId: string): Promise<WorkspaceSnapshot | undefined> {
    return this.readJson(join(this.root, 'sessions', sessionId, 'snapshots', snapshotId, 'snapshot.json'));
  }

  async copyDirectory(source: string, target: string): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    const text = await this.readText(path);
    return text ? JSON.parse(text) as T : undefined;
  }

  private async readText(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }
}