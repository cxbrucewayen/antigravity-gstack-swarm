/**
 * Windows-only: keep the `gstack browse` daemon alive across Antigravity `run_command` calls.
 *
 * On Windows, Antigravity kills a command's whole process tree when the command
 * ends. The browse CLI starts its daemon detached, which is enough on macOS and
 * Linux (setsid) but not here: the daemon dies with the command, so the next
 * `$B ...` call boots a fresh browser on about:blank and loses the page.
 *
 * When a command is about to use browse and the project's daemon is not running,
 * start it through WMI (Win32_Process.Create). WMI creates the process on behalf
 * of the caller, outside the caller's process tree, so the daemon survives and
 * shuts down on its own idle timeout as usual. This never decides anything about
 * the command; callers keep their own allow/deny logic.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IS_WIN, gstackRoot, stateRoot } from './lib-paths.mjs';

// `gstack browse ...` or a path to the browse binary (case-insensitive, as Windows paths are).
const BROWSE_CALL_RE = /\bgstack(?:\.ps1|\.cmd)?["']?\s+browse\b|[\\/]browse[\\/]dist[\\/]browse(?:\.exe)?["']?\s/i;
// The skills' `$B <subcommand>`. Case-sensitive so PowerShell's `$b = ...` does not match.
const DOLLAR_B_RE = /\$\{?B\}?["']?\s+[a-z][a-z-]*\b/;
// Headed/handoff flows need the interactive desktop, which a WMI-created process does not get;
// `stop` / `disconnect` would only start a daemon to tear it down.
const SKIP_SUBCMD_RE = /(?:\bbrowse(?:\.exe)?["']?|\$\{?B\}?["']?)\s+(?:connect|disconnect|stop|handoff|headed)\b/i;
const SKIP_HEADED_RE = /BROWSE_HEADED|--headed\b|open-gstack-browser|pair-agent/i;

const BOOT_WAIT_MS = 20000;

/** True when the command line runs the browse CLI (directly, via `gstack browse`, or via the skills' `$B`). */
export function commandUsesBrowse(cmd) {
  if (typeof cmd !== 'string') return false;
  if (!BROWSE_CALL_RE.test(cmd) && !DOLLAR_B_RE.test(cmd)) return false;
  return !SKIP_SUBCMD_RE.test(cmd) && !SKIP_HEADED_RE.test(cmd);
}

/** Same resolution as browse/src/config.ts: BROWSE_STATE_FILE, else <git root or cwd>/.gstack/browse.json. */
export function browseStateFile(cwd, env = process.env) {
  if (env.BROWSE_STATE_FILE) return env.BROWSE_STATE_FILE;
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
  const root = r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : cwd;
  return path.join(root, '.gstack', 'browse.json');
}

async function daemonHealthy(stateFile) {
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return false; }
  if (!state?.pid || !state?.port) return false;
  try { process.kill(state.pid, 0); } catch { return false; }
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function startOutsideProcessTree(browseExe, cwd, stateFile) {
  const commandLine = `cmd.exe /d /c set "BROWSE_STATE_FILE=${stateFile}" && "${browseExe}" url`;
  const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)}; CurrentDirectory = ${psQuote(cwd)} }; exit [int]$r.ReturnValue`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 10000, windowsHide: true });
  return r.status === 0;
}

function log(line) {
  try {
    const dir = path.join(stateRoot(), 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'win-browse-daemon.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging is best effort */ }
}

/**
 * Called by the run_command PreToolUse hook with the raw payload. Never throws,
 * never writes to stdout, and returns quickly when there is nothing to do.
 */
export async function warmBrowseDaemon(rawPayload, { platformIsWindows = IS_WIN, env = process.env } = {}) {
  try {
    if (!platformIsWindows) return 'skip:not-windows';
    if (['off', 'no', 'false', '0'].includes((env.GSTACK_WIN_BROWSE_WARMUP || '').trim().toLowerCase())) return 'skip:disabled';
    const payload = JSON.parse(rawPayload || '{}');
    const cmd = payload?.toolCall?.args?.CommandLine;
    if (!commandUsesBrowse(cmd)) return 'skip:no-browse';

    const cwd = payload?.toolCall?.args?.Cwd || payload?.cwd || process.cwd();
    if (!fs.existsSync(cwd)) return 'skip:no-cwd';
    const browseExe = path.join(gstackRoot(), 'browse', 'dist', 'browse.exe');
    if (!fs.existsSync(browseExe)) return 'skip:no-browse-exe';

    const stateFile = browseStateFile(cwd, env);
    if (await daemonHealthy(stateFile)) return 'ok:already-running';

    if (!startOutsideProcessTree(browseExe, cwd, stateFile)) {
      log(`start-failed cwd=${cwd}`);
      return 'fail:start';
    }
    const deadline = Date.now() + BOOT_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      if (await daemonHealthy(stateFile)) {
        log(`started cwd=${cwd} state=${stateFile}`);
        return 'ok:started';
      }
    }
    log(`boot-timeout cwd=${cwd} state=${stateFile}`);
    return 'fail:timeout';
  } catch (err) {
    log(`error ${err instanceof Error ? err.message : String(err)}`);
    return 'fail:error';
  }
}
