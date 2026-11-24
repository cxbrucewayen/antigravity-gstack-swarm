import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WRITE_HOOK = path.join(REPO_ROOT, 'plugin', 'hooks', 'pre-tool-write.mjs');
const STOP_HOOK = path.join(REPO_ROOT, 'plugin', 'hooks', 'stop-gate.mjs');
const SWARM_LOCK = path.join(REPO_ROOT, 'runtime', 'bin', 'gstack-swarm-lock.mjs');
const COMMAND_HOOK = path.join(REPO_ROOT, 'plugin', 'hooks', 'pre-tool-command.mjs');
const WIN_BROWSE = path.join(REPO_ROOT, 'plugin', 'hooks', 'win-browse-daemon.mjs');

function runHook(hookPath, payloadObj, envExtra = {}) {
  const r = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(payloadObj),
    encoding: 'utf8',
    env: { ...process.env, ...envExtra },
  });
  assert.equal(r.status, 0, `Hook exited with ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim() || '{}');
}

test('Zero-Trust Role Guard blocks @pm-ceo from editing code while allowing PRD markdown', () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-state-'));
  const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-proj-'));
  try {
    const pmTranscript = path.join(tmpProj, 'pm.jsonl');
    fs.writeFileSync(pmTranscript, '{"type":"USER_INPUT","content":"<swarm_worker>\\n@pm-ceo You own docs/specs/app-spec.md"}\n');

    const codeRes = runHook(WRITE_HOOK, {
      conversationId: 'conv-pm-1',
      transcriptPath: pmTranscript,
      cwd: tmpProj,
      toolCall: { name: 'write_file', args: { Path: path.join(tmpProj, 'src', 'index.ts') } },
    }, { GSTACK_STATE_ROOT: tmpState });
    assert.equal(codeRes.decision, 'deny');
    assert.match(codeRes.reason, /Zero-Trust Role Guard/);

    const specRes = runHook(WRITE_HOOK, {
      conversationId: 'conv-pm-1',
      transcriptPath: pmTranscript,
      cwd: tmpProj,
      toolCall: { name: 'write_file', args: { Path: path.join(tmpProj, 'docs', 'specs', 'app-spec.md') } },
    }, { GSTACK_STATE_ROOT: tmpState });
    assert.equal(specRes.decision, 'allow');
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
    fs.rmSync(tmpProj, { recursive: true, force: true });
  }
});

test('Zero-Trust Verifier Guard blocks @qa-lead from editing src/ while allowing tests/', () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-state-'));
  const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-proj-'));
  try {
    const qaTranscript = path.join(tmpProj, 'qa.jsonl');
    fs.writeFileSync(qaTranscript, '{"type":"USER_INPUT","content":"<swarm_worker>\\n@qa-lead 【核心职责】：执行验收"}\n');

    const srcRes = runHook(WRITE_HOOK, {
      conversationId: 'conv-qa-1',
      transcriptPath: qaTranscript,
      cwd: tmpProj,
      toolCall: { name: 'edit_file', args: { Path: path.join(tmpProj, 'src', 'api.ts') } },
    }, { GSTACK_STATE_ROOT: tmpState });
    assert.equal(srcRes.decision, 'deny');
    assert.match(srcRes.reason, /Zero-Trust Verifier Guard/);

    const testRes = runHook(WRITE_HOOK, {
      conversationId: 'conv-qa-1',
      transcriptPath: qaTranscript,
      cwd: tmpProj,
      toolCall: { name: 'write_file', args: { Path: path.join(tmpProj, 'tests', 'api.test.ts') } },
    }, { GSTACK_STATE_ROOT: tmpState });
    assert.equal(testRes.decision, 'allow');
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
    fs.rmSync(tmpProj, { recursive: true, force: true });
  }
});

test('Project .gstack/swarm-ownership.json enforces non-colliding fe-dev and be-dev boundaries', () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-state-'));
  const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-proj-'));
  try {
    fs.mkdirSync(path.join(tmpProj, '.gstack'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProj, '.gstack', 'swarm-ownership.json'),
      JSON.stringify({
        'be-dev': { allow: ['src/server/**'], deny: ['src/client/**'] },
        'fe-dev': { allow: ['src/client/**'], deny: ['src/server/**'] },
      })
    );

    const beTranscript = path.join(tmpProj, 'be.jsonl');
    fs.writeFileSync(beTranscript, '{"type":"USER_INPUT","content":"<swarm_worker>\\n@be-dev You own src/server/"}\n');

    const crossEdit = runHook(WRITE_HOOK, {
      conversationId: 'conv-be-99',
      transcriptPath: beTranscript,
      cwd: tmpProj,
      toolCall: { name: 'edit_file', args: { Path: path.join(tmpProj, 'src', 'client', 'App.tsx') } },
    }, { GSTACK_STATE_ROOT: tmpState });
    assert.equal(crossEdit.decision, 'deny');

    const ownEdit = runHook(WRITE_HOOK, {
      conversationId: 'conv-be-99',
      transcriptPath: beTranscript,
      cwd: tmpProj,
      toolCall: { name: 'edit_file', args: { Path: path.join(tmpProj, 'src', 'server', 'routes.ts') } },
    }, { GSTACK_STATE_ROOT: tmpState });
    assert.equal(ownEdit.decision, 'allow');
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
    fs.rmSync(tmpProj, { recursive: true, force: true });
  }
});

test('Session-scoped freeze isolates @debugger without blocking concurrent @fe-dev session', () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-state-'));
  const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-proj-'));
  try {
    const setRes = spawnSync(process.execPath, [SWARM_LOCK, 'freeze-session', '--session', 'dbg-1', '--dir', path.join(tmpProj, 'src', 'auth')], {
      encoding: 'utf8',
      env: { ...process.env, GSTACK_STATE_ROOT: tmpState },
    });
    assert.equal(setRes.status, 0);

    const dbgBlocked = runHook(WRITE_HOOK, {
      conversationId: 'dbg-1',
      cwd: tmpProj,
      toolCall: { name: 'edit_file', args: { Path: path.join(tmpProj, 'src', 'ui', 'Button.tsx') } },
    }, { GSTACK_STATE_ROOT: tmpState });
    assert.equal(dbgBlocked.decision, 'deny');

    const feAllowed = runHook(WRITE_HOOK, {
      conversationId: 'fe-1',
      cwd: tmpProj,
      toolCall: { name: 'edit_file', args: { Path: path.join(tmpProj, 'src', 'ui', 'Button.tsx') } },
    }, { GSTACK_STATE_ROOT: tmpState });
    assert.equal(feAllowed.decision, 'allow');
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
    fs.rmSync(tmpProj, { recursive: true, force: true });
  }
});

test('Stop contract gate blocks once when gstack-investigate finishes without root cause & evidence, then never loops', () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-state-'));
  const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-proj-'));
  try {
    const transcript = path.join(tmpProj, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'Fix the crash' }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        content: 'Fixed it!',
        tool_calls: [{ name: 'read_file', args: { Path: '/plugins/gstack-swarm/skills/gstack-investigate/SKILL.md' } }],
      }),
    ];
    fs.writeFileSync(transcript, lines.join('\n') + '\n');

    const firstStop = runHook(STOP_HOOK, {
      conversationId: 'stop-conv-1',
      transcriptPath: transcript,
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: false,
      fullyIdle: true,
    }, { GSTACK_STATE_ROOT: tmpState });
    assert.equal(firstStop.decision, 'continue');
    assert.match(firstStop.reason, /SKILL_CONTRACT_UNMET gstack-investigate/);

    // Second stop on same turn never blocks again
    const secondStop = runHook(STOP_HOOK, {
      conversationId: 'stop-conv-1',
      transcriptPath: transcript,
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: false,
      fullyIdle: true,
    }, { GSTACK_STATE_ROOT: tmpState });
    assert.deepEqual(secondStop, {});
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
    fs.rmSync(tmpProj, { recursive: true, force: true });
  }
});

test('Windows browse warm-up only recognizes real browse invocations', async () => {
  const { commandUsesBrowse } = await import(pathToFileURL(WIN_BROWSE).href);
  const yes = [
    'gstack browse goto https://example.com',
    'gstack.ps1 browse text',
    '$B goto https://example.com/stop',
    '${B} js document.title',
    'B=$GSTACK_ROOT/browse/dist/browse; $B goto http://localhost:3000',
    '"C:/tools/gstack/browse/dist/browse.exe" text',
  ];
  const no = [
    'npm test',
    'echo browse',
    '$b = 1',
    '$BUILD_DIR/run',
    'ls browse/dist/find-browse',
    '$B stop',
    'gstack browse connect',
    'BROWSE_HEADED=1 gstack browse goto https://example.com',
  ];
  for (const cmd of yes) assert.equal(commandUsesBrowse(cmd), true, cmd);
  for (const cmd of no) assert.equal(commandUsesBrowse(cmd), false, cmd);
});

test('Windows browse warm-up is a no-op off Windows, when disabled, or without a browse binary', async () => {
  const { warmBrowseDaemon } = await import(pathToFileURL(WIN_BROWSE).href);
  const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-proj-'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-root-'));
  const prevRoot = process.env.GSTACK_ROOT;
  try {
    const payload = (cmd) => JSON.stringify({ cwd: tmpProj, toolCall: { name: 'run_command', args: { CommandLine: cmd } } });
    assert.equal(await warmBrowseDaemon(payload('gstack browse goto https://example.com'), { platformIsWindows: false }), 'skip:not-windows');
    assert.equal(await warmBrowseDaemon(payload('gstack browse goto https://example.com'), { platformIsWindows: true, env: { GSTACK_WIN_BROWSE_WARMUP: 'off' } }), 'skip:disabled');
    assert.equal(await warmBrowseDaemon(payload('npm test'), { platformIsWindows: true, env: {} }), 'skip:no-browse');
    process.env.GSTACK_ROOT = tmpRoot;
    assert.equal(await warmBrowseDaemon(payload('gstack browse goto https://example.com'), { platformIsWindows: true, env: {} }), 'skip:no-browse-exe');
    assert.equal(fs.existsSync(path.join(tmpProj, '.gstack')), false);
  } finally {
    if (prevRoot === undefined) delete process.env.GSTACK_ROOT; else process.env.GSTACK_ROOT = prevRoot;
    fs.rmSync(tmpProj, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Command guard decisions are unchanged by the browse warm-up', () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-test-state-'));
  try {
    const run = (cmd) => runHook(COMMAND_HOOK, { cwd: os.tmpdir(), toolCall: { name: 'run_command', args: { CommandLine: cmd } } },
      { GSTACK_STATE_ROOT: tmpState, GSTACK_ROOT: tmpState });
    assert.equal(run('ls -la').decision, 'allow');
    assert.equal(run('gstack browse goto https://example.com').decision, 'allow');
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});
