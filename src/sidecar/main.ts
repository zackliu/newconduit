import { SidecarDaemon } from './sidecar-daemon';

async function main(): Promise<void> {
  const daemon = new SidecarDaemon();
  await daemon.connect('webpubsub://poc');
  console.log('sidecar daemon framework started');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});