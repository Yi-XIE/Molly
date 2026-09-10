import { spawn } from 'node:child_process';

const requestedMode = process.argv[2] ?? 'pi';
if (!['pi', 'preview'].includes(requestedMode)) {
  console.error(`Unsupported Molly runtime mode: ${requestedMode}`);
  process.exit(1);
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npmCommand, ['run', 'dev', '-w', '@molly/desktop'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    MOLLY_RUNTIME_MODE: requestedMode,
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(`Unable to start Molly desktop: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
