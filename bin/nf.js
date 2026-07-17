#!/usr/bin/env node
// Dev launcher: runs the TypeScript CLI via tsx without a build step.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: path.join(here, '..'),
});
process.exit(result.status ?? 1);
