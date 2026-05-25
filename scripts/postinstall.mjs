#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

const PLIST = `${homedir()}/Library/LaunchAgents/de.9di.mcp-mail.plist`;
const LABEL = 'de.9di.mcp-mail';

function log(msg) { console.log(`[mcp-mail postinstall] ${msg}`); }

if (!existsSync(PLIST)) {
  log('LaunchAgent plist not found — skipping (likely a non-daemon install).');
  process.exit(0);
}

const plist = readFileSync(PLIST, 'utf8');
const m = plist.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/);
if (!m) {
  log('could not parse ProgramArguments from plist — skipping.');
  process.exit(0);
}
const daemonNode = m[1];

if (!existsSync(daemonNode)) {
  console.error(`[mcp-mail postinstall] ERROR: plist references missing node binary: ${daemonNode}`);
  console.error('Update the plist (ProgramArguments[0] and PATH) or install that node version, then re-run `npm install`.');
  process.exit(1);
}

const daemonAbi = execFileSync(daemonNode, ['-e', 'process.stdout.write(process.versions.modules)']).toString().trim();
const currentAbi = process.versions.modules;

if (daemonAbi !== currentAbi) {
  log(`ABI mismatch: npm node=${currentAbi}, daemon node=${daemonAbi} (${daemonNode}). Rebuilding better-sqlite3 against daemon node.`);
  execFileSync('npm', ['rebuild', 'better-sqlite3'], {
    stdio: 'inherit',
    env: { ...process.env, PATH: `${dirname(daemonNode)}:${process.env.PATH ?? ''}` },
  });
  log('rebuild complete.');
} else {
  log(`node ABI ${currentAbi} matches daemon — no rebuild needed.`);
}

const uid = process.getuid();
try {
  execFileSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
} catch {
  log('daemon not loaded — skipping restart.');
  process.exit(0);
}

try {
  execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  log('daemon restarted.');
} catch (err) {
  console.error(`[mcp-mail postinstall] failed to restart daemon: ${err.message}`);
}
