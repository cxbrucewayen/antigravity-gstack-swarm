#!/usr/bin/env node
/**
 * Antigravity PreToolUse hook for `run_command` -> gstack `/careful` destructive command guard.
 * Portable across Windows, macOS, and Linux (zero hardcoded user paths).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IS_WIN, buildCleanEnv, gstackRoot, resolveBash, stateRoot, toMsysPath } from './lib-paths.mjs';
import { warmBrowseDaemon } from './win-browse-daemon.mjs';

function isDestructiveGuardEnabled() {
  const envVal = (process.env.GSTACK_DESTRUCTIVE_GUARD || '').trim().toLowerCase();
  if (['off', 'no', 'false', '0'].includes(envVal)) return false;
  if (['on', 'yes', 'true', '1'].includes(envVal)) return true;
  try {
    const cfg = fs.readFileSync(path.join(stateRoot(), 'config.yaml'), 'utf8');
    const m = /^destructive_guard:\s*(\S+)/m.exec(cfg);
    if (m && ['off', 'no', 'false', '0'].includes(m[1].toLowerCase())) return false;
  } catch { /* default is on */ }
  return true;
}

const WATCHED_RE = /\b(rm|del|erase|rd|rmdir|remove-item|ri|shred|unlink|rsync|find|drop|truncate|delete|flushall|prisma|dropdb|push|reset|checkout|restore|clean|stash|worktree|filter-branch|bfg|reflog|terraform|aws|gcloud|az|kubectl|docker|format-volume|clear-disk|clear-content|encodedcommand|enc|iex|invoke-expression|start-process|mkfs|dd|base64)\b|\[io\.(directory|file)\]|[$]\{?ifs\}?/i;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  // Windows: start the browse daemon outside Antigravity's per-command process tree (no-op elsewhere).
  await warmBrowseDaemon(raw);
  try {
    if (!isDestructiveGuardEnabled()) {
      process.stdout.write('{"decision":"allow"}\n');
      return;
    }
    const payload = JSON.parse(raw || '{}');
    const cmd = payload?.toolCall?.args?.CommandLine;
    if (typeof cmd !== 'string' || !cmd.trim()) {
      process.stdout.write('{"decision":"allow"}\n');
      return;
    }

    const customGlobal = path.join(stateRoot(), 'careful-patterns.txt');
    if (!WATCHED_RE.test(cmd) && !fs.existsSync(customGlobal)) {
      process.stdout.write('{"decision":"allow"}\n');
      return;
    }

    const checkScript = path.join(gstackRoot(), 'careful', 'bin', 'check-careful.sh');
    if (!fs.existsSync(checkScript)) {
      process.stdout.write('{"decision":"allow"}\n');
      return;
    }

    const claudeShaped = JSON.stringify({
      tool_name: IS_WIN ? 'PowerShell' : 'Bash',
      cwd: payload?.cwd || process.cwd(),
      tool_input: { command: cmd },
    });

    const r = spawnSync(resolveBash(), [toMsysPath(checkScript)], {
      input: claudeShaped,
      encoding: 'utf8',
      timeout: 8000,
      env: buildCleanEnv(),
    });

    const out = (r.stdout || '').trim();
    if (!out || out === '{}') {
      process.stdout.write('{"decision":"allow"}\n');
      return;
    }

    const parsed = JSON.parse(out);
    const dec = parsed?.hookSpecificOutput?.permissionDecision;
    const reason = parsed?.hookSpecificOutput?.permissionDecisionReason || '[gstack careful] Destructive command detected.';
    if (dec === 'deny') {
      process.stdout.write(JSON.stringify({ decision: 'deny', reason }) + '\n');
      return;
    }
    if (dec === 'ask') {
      process.stdout.write(JSON.stringify({
        decision: 'ask',
        reason: `${reason} (gstack /careful guard; disable via: gstack config set destructive_guard off)`,
      }) + '\n');
      return;
    }
    process.stdout.write('{"decision":"allow"}\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({
      decision: 'ask',
      reason: `[gstack careful] Could not parse command payload (${err instanceof Error ? err.message : String(err)}). Approve only if safe.`,
    }) + '\n');
  }
});
