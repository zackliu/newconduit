import { readConfig } from './config';
import { mountConsole } from './console';
import { mountEdge } from './edge';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) {
  throw new Error('missing #app root element');
}

const config = readConfig();
document.body.dataset.role = config.role;

if (config.role === 'edge') {
  mountEdge(root, config);
} else {
  mountConsole(root, config);
}
