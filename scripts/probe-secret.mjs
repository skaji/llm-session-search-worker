import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
if (!existsSync('.dev.vars')) {
  writeFileSync('.dev.vars', `PROBE_TOKEN=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
}
if (process.argv.includes('--remote')) {
  const token = readFileSync('.dev.vars', 'utf8').match(/^PROBE_TOKEN=(\S+)$/m)?.[1];
  if (!token) throw new Error('Missing PROBE_TOKEN in .dev.vars');
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'PROBE_TOKEN', '--config', 'wrangler.probe.jsonc'], {
    input: token, stdio: ['pipe', 'inherit', 'inherit'],
  });
} else {
  console.log('Local probe secret is ready in ignored .dev.vars.');
}
