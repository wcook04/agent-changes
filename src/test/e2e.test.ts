// Drives the real hook script the way Claude Code does, then checks what the tracker reports.

import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { HOOK_FILE, installHookSettings, syncHookFiles } from '../engine/install';
import { UNATTRIBUTED } from '../engine/model';
import { Tracker } from '../engine/tracker';

// The hook runs from an install folder laid out the way the extension sets it up.
const INSTALL = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-changes-install-'));
syncHookFiles(path.join(__dirname, '..', '..'), INSTALL);
const HOOK = path.join(INSTALL, HOOK_FILE);
const CLI = path.join(INSTALL, 'cli.js');
const SESSION = 'sess-1111-2222';
const OTHER = 'sess-3333-4444';
const MAIN = SESSION;
const WRITER = `${SESSION}/agent-writer`;
const SHELL = `${SESSION}/agent-shell`;

const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

function setupRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-changes-e2e-'));
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), ten);
  fs.writeFileSync(path.join(dir, 'b.txt'), 'alpha\nbeta\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  fs.mkdirSync(path.join(dir, '.git', 'agent-changes'));
  return dir;
}

let tool = 0;
function hook(dir: string, payload: Record<string, unknown>) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: dir, session_id: SESSION, ...payload }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'the hook must stay silent');
}

/** Runs `change` between a PreToolUse and a PostToolUse for one tool call. */
function toolCall(dir: string, who: { agent_id?: string; agent_type?: string; session_id?: string }, name: string, input: Record<string, unknown>, change: () => void) {
  const id = `toolu_${++tool}`;
  const base = { ...who, tool_name: name, tool_input: input, tool_use_id: id };
  hook(dir, { ...base, hook_event_name: 'PreToolUse' });
  change();
  hook(dir, { ...base, hook_event_name: 'PostToolUse', tool_response: {} });
}

function edit(dir: string, who: object, file: string, from: string, to: string) {
  const abs = path.join(dir, file);
  toolCall(dir, who, 'Edit', { file_path: abs, old_string: from, new_string: to }, () =>
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(from, to)),
  );
}

const writer = { agent_id: 'agent-writer', agent_type: 'general-purpose' };
const shell = { agent_id: 'agent-shell', agent_type: 'general-purpose' };

test('end to end: attribution, staging one agent, commit, discard', async () => {
  const dir = setupRepo();
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  hook(dir, { hook_event_name: 'UserPromptSubmit', prompt: 'Refactor the line handling' });
  edit(dir, {}, 'a.txt', 'line 2\n', 'line two\n');
  edit(dir, writer, 'a.txt', 'line 9\n', 'line nine\n');
  toolCall(dir, writer, 'Write', { file_path: path.join(dir, 'src', 'new.txt'), content: 'hello\n' }, () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'new.txt'), 'hello\n');
  });
  toolCall(dir, shell, 'Bash', { command: 'echo gamma >> b.txt; echo y > y.txt' }, () => {
    fs.appendFileSync(path.join(dir, 'b.txt'), 'gamma\n');
    fs.writeFileSync(path.join(dir, 'y.txt'), 'y\n');
  });
  toolCall(dir, shell, 'Bash', { command: 'ls' }, () => {}); // read-only commands record nothing
  hook(dir, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Agent',
    tool_input: { description: 'Write the new module', subagent_type: 'general-purpose' },
    tool_response: { agentId: 'agent-writer', agentType: 'general-purpose' },
  });
  fs.writeFileSync(path.join(dir, 'b.txt'), read('b.txt').replace('alpha', 'ALPHA')); // a manual edit

  const tracker = (await Tracker.open(dir))!;
  let snap = await tracker.compute();
  const ownersOf = (f: string) => [...(snap.files.get(f)?.owners ?? [])].sort();
  assert.deepEqual(ownersOf('a.txt'), [MAIN, WRITER].sort());
  assert.deepEqual(ownersOf('src/new.txt'), [WRITER]);
  assert.deepEqual(ownersOf('y.txt'), [SHELL]);
  assert.deepEqual(ownersOf('b.txt'), [SHELL, UNATTRIBUTED].sort());

  const labels = Object.fromEntries(snap.owners.map((o) => [o.id, o.label]));
  assert.equal(labels[MAIN], 'Refactor the line handling');
  assert.equal(labels[WRITER], 'Write the new module (general-purpose)');
  assert.equal(labels[SHELL], 'general-purpose agent-s');
  const colors = snap.owners.filter((o) => o.id !== UNATTRIBUTED).map((o) => o.color);
  assert.equal(new Set(colors).size, colors.length, 'each agent gets its own color');
  assert.equal(snap.owners.at(-1)!.color, -1);
  assert.equal(snap.owners.at(-1)!.id, UNATTRIBUTED);

  // Stage only the writer's work: its line in a.txt plus its new file.
  await tracker.setStaged(['a.txt', 'src/new.txt'], WRITER, true);
  assert.equal(git('show', ':a.txt'), ten.replace('line 9\n', 'line nine\n'));
  assert.equal(git('show', ':src/new.txt'), 'hello\n');
  assert.equal(git('diff', '--cached', '--name-only').trim().split('\n').sort().join(','), 'a.txt,src/new.txt');

  await tracker.commit('Writer agent changes');
  snap = await tracker.compute();
  assert.deepEqual(ownersOf('a.txt'), [MAIN]); // the committed line is no longer a change
  assert.equal(snap.files.has('src/new.txt'), false);
  assert.equal(tracker.version(snap.files.get('a.txt')!, [MAIN]).text, read('a.txt'));

  // Discard the shell agent: its appended line and new file go, the manual edit stays.
  await tracker.discard(['b.txt', 'y.txt'], SHELL);
  assert.equal(read('b.txt'), 'ALPHA\nbeta\n');
  assert.equal(fs.existsSync(path.join(dir, 'y.txt')), false);
  snap = await tracker.compute();
  assert.deepEqual(ownersOf('b.txt'), [UNATTRIBUTED]);
  assert.equal(snap.files.has('y.txt'), false);
});

test('two selected commits preserve ownership across a fresh tracker', async () => {
  const dir = setupRepo();
  const read = () => fs.readFileSync(path.join(dir, 'a.txt'), 'utf8');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const base = git('rev-parse', 'HEAD').trim();
  const writerText = ten.replace('line 9\n', 'line nine\n');
  const both = writerText.replace('line 2\n', 'line two\n');
  edit(dir, {}, 'a.txt', 'line 2\n', 'line two\n');
  edit(dir, writer, 'a.txt', 'line 9\n', 'line nine\n');

  const tracker = (await Tracker.open(dir))!;
  await tracker.setStaged(['a.txt'], WRITER, true);
  assert.equal(git('show', ':a.txt'), writerText);
  assert.equal(read(), both, "staging the writer leaves both agents' working edits in place");
  await tracker.commit('Writer first');
  const first = git('rev-parse', 'HEAD').trim();
  assert.equal(git('rev-parse', `${first}^`).trim(), base);
  assert.equal(git('show', `${first}:a.txt`), writerText);
  assert.equal(git('diff', '--cached'), '');
  assert.equal(read(), both);

  // Reopen before computing again: the durable checkpoint still has the old HEAD.
  const reopened = (await Tracker.open(dir))!;
  let snap = await reopened.compute();
  assert.equal(snap.head, first);
  assert.deepEqual([...snap.files.keys()], ['a.txt']);
  assert.deepEqual(snap.files.get('a.txt')!.owners, [MAIN]);
  assert.deepEqual(snap.files.get('a.txt')!.unstaged, [MAIN]);
  assert.deepEqual(snap.staged, []);

  await reopened.setStaged(['a.txt'], MAIN, true);
  assert.equal(git('show', ':a.txt'), both);
  await reopened.commit('Main follows');
  const second = git('rev-parse', 'HEAD').trim();
  assert.equal(git('rev-parse', `${second}^`).trim(), first);
  assert.equal(git('show', `${first}:a.txt`), writerText);
  assert.equal(git('show', `${second}:a.txt`), both);
  assert.equal(git('write-tree').trim(), git('rev-parse', 'HEAD^{tree}').trim(), 'index equals HEAD');
  assert.equal(read(), both);
  assert.equal(git('status', '--porcelain'), '');
  snap = await reopened.compute();
  assert.equal(snap.files.size, 0);
  assert.deepEqual(snap.staged, []);
  assert.deepEqual(snap.owners, []);
});

test('overlapping shell commands from different agents are left unattributed', async () => {
  const dir = setupRepo();
  const pre = (who: object, id: string) =>
    hook(dir, { ...who, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: id });
  const post = (who: object, id: string) =>
    hook(dir, { ...who, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: id, tool_response: {} });
  pre(writer, 'b1');
  pre(shell, 'b2');
  fs.writeFileSync(path.join(dir, 'p.txt'), 'p\n');
  post(writer, 'b1');
  fs.writeFileSync(path.join(dir, 'q.txt'), 'q\n');
  post(shell, 'b2');
  const snap = await (await Tracker.open(dir))!.compute();
  assert.deepEqual(snap.files.get('p.txt')?.owners, [UNATTRIBUTED]);
  assert.deepEqual(snap.files.get('q.txt')?.owners, [UNATTRIBUTED]);
});

test('staged changes move to one Staged list that remembers where each came from', async () => {
  const dir = setupRepo();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  edit(dir, {}, 'a.txt', 'line 2\n', 'line two\n');
  edit(dir, writer, 'a.txt', 'line 9\n', 'line nine\n');
  edit(dir, shell, 'b.txt', 'alpha\n', 'ALPHA\n');
  const tracker = (await Tracker.open(dir))!;

  await tracker.setStaged(['a.txt'], WRITER, true);
  let snap = await tracker.compute();
  assert.deepEqual(
    snap.staged.map((s) => [s.path, s.status, s.owners]),
    [['a.txt', 'M', [WRITER]]],
  );
  const a = snap.files.get('a.txt')!;
  assert.deepEqual(a.unstaged, [MAIN], "the writer's part left its group; the main agent's part is still unstaged");

  // The writer edits the same file again: its group shows the new edit, the staged row stays its own.
  edit(dir, writer, 'a.txt', 'line 10\n', 'line ten\n');
  snap = await tracker.compute();
  assert.deepEqual(snap.staged[0].owners, [WRITER]);
  assert.deepEqual([...snap.files.get('a.txt')!.unstaged].sort(), [MAIN, WRITER].sort());

  // Staging a whole file from the Git view is attributed to everyone who changed it.
  git('add', 'b.txt');
  snap = await tracker.compute();
  assert.deepEqual(snap.staged.find((s) => s.path === 'b.txt')!.owners, [SHELL]);
  assert.deepEqual(snap.files.get('b.txt')!.unstaged, []);

  await tracker.unstagePaths(['a.txt', 'b.txt']);
  snap = await tracker.compute();
  assert.deepEqual(snap.staged, []);
  assert.equal(git('diff', '--cached', '--name-only').trim(), '');
  assert.deepEqual([...snap.files.get('a.txt')!.unstaged].sort(), [MAIN, WRITER].sort());
});

test('discard all empties Changes and keeps what is staged, like Git', async () => {
  const dir = setupRepo();
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  edit(dir, {}, 'a.txt', 'line 2\n', 'line two\n');
  edit(dir, writer, 'a.txt', 'line 9\n', 'line nine\n');
  toolCall(dir, shell, 'Write', { file_path: path.join(dir, 'src', 'deep', 'new.txt'), content: 'hello\n' }, () => {
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'deep', 'new.txt'), 'hello\n');
  });
  fs.writeFileSync(path.join(dir, 'b.txt'), 'ALPHA\nbeta\n'); // a manual edit
  const tracker = (await Tracker.open(dir))!;
  await tracker.setStaged(['a.txt'], WRITER, true);
  edit(dir, writer, 'a.txt', 'line 10\n', 'line ten\n'); // the writer goes on after being staged
  const staged = ten.replace('line 9\n', 'line nine\n');

  let snap = await tracker.compute();
  const listed = [...snap.files.values()].filter((f) => f.unstaged.length).map((f) => f.path);
  assert.deepEqual(listed.sort(), ['a.txt', 'b.txt', 'src/deep/new.txt']);
  await tracker.discardUnstaged(listed);

  assert.equal(read('a.txt'), staged, 'back to what is staged, not to HEAD');
  assert.equal(git('show', ':a.txt'), staged, 'the index is untouched');
  assert.equal(read('b.txt'), 'alpha\nbeta\n');
  assert.equal(fs.existsSync(path.join(dir, 'src')), false, 'created files go, with the folders they made');
  snap = await tracker.compute();
  assert.deepEqual([...snap.files.values()].filter((f) => f.unstaged.length), [], 'Changes is empty');
  assert.deepEqual(snap.staged.map((s) => [s.path, s.owners]), [['a.txt', [WRITER]]]);

  // The staged part still commits as the writer's, and nothing is left over afterwards.
  await tracker.commit('Writer');
  snap = await tracker.compute();
  assert.equal(snap.files.size, 0);
  assert.equal(git('status', '--porcelain'), '');
});

test('staged content nobody can be credited with is shown and protected', async () => {
  const dir = setupRepo();
  edit(dir, {}, 'a.txt', 'line 1\n', 'line one\n');
  const file = path.join(dir, 'a.txt');
  const agentText = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, 'something else entirely\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: dir });
  fs.writeFileSync(file, agentText);
  const tracker = (await Tracker.open(dir))!;
  const snap = await tracker.compute();
  assert.deepEqual(snap.staged.map((s) => [s.path, s.owners]), [['a.txt', []]]);
  await assert.rejects(() => tracker.setStaged(['a.txt'], MAIN, true), /already has other staged changes/);
});

test('the hook does nothing in repositories where tracking is off', () => {
  const dir = setupRepo();
  fs.rmSync(path.join(dir, '.git', 'agent-changes'), { recursive: true });
  edit(dir, {}, 'a.txt', 'line 2\n', 'line two\n');
  assert.equal(fs.existsSync(path.join(dir, '.git', 'agent-changes')), false);
});

test("the guard stops git commands that would take in or erase another session's work", () => {
  const dir = setupRepo();
  const other = { session_id: OTHER };
  hook(dir, { ...other, hook_event_name: 'UserPromptSubmit', prompt: 'Fix the dates' });
  edit(dir, {}, 'a.txt', 'line 2\n', 'line two\n'); // this session
  edit(dir, writer, 'b.txt', 'alpha\n', 'ALPHA\n'); // this session's subagent: still its own work
  edit(dir, other, 'a.txt', 'line 9\n', 'line nine\n'); // another session, same file
  toolCall(dir, other, 'Write', { file_path: path.join(dir, 'notes.txt'), content: 'n\n' }, () => fs.writeFileSync(path.join(dir, 'notes.txt'), 'n\n'));
  fs.mkdirSync(path.join(dir, 'sub'));

  const pending = () => fs.readdirSync(path.join(dir, '.git', 'agent-changes', 'pending')).length;
  const ask = (command: string, name = 'Bash') => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ cwd: dir, session_id: SESSION, hook_event_name: 'PreToolUse', tool_name: name, tool_input: { command }, tool_use_id: `toolu_${++tool}` }),
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  };
  const blocked = (command: string, name = 'Bash') => {
    const before = pending();
    const out = ask(command, name);
    assert.equal(out?.permissionDecision, 'deny', `${command} should be blocked`);
    assert.equal(pending(), before, 'a blocked command leaves nothing pending');
    return out.permissionDecisionReason as string;
  };
  const allowed = (command: string) => assert.equal(ask(command), null, `${command} should run`);

  const reason = blocked('git add -A');
  assert.match(reason, /stage uncommitted work that another Claude session made/);
  assert.match(reason, /"Fix the dates" \(another session\): a\.txt, notes\.txt/);
  assert.match(reason, new RegExp(`cli\\.js" stage --session ${SESSION}`));
  assert.match(blocked('git checkout -- .'), new RegExp(`cli\\.js" discard --session ${SESSION}`));
  assert.match(blocked('git add -A', 'PowerShell'), /\$env:AGENT_CHANGES_ALLOW=1;/);
  for (const command of [
    'git add .',
    'git add a.txt',
    'cd sub && git add ..',
    'git -C sub add -A',
    'git status && git add -A && git commit -m "wip"',
    'git commit -am "wip"',
    'git commit -m wip a.txt',
    'git checkout .',
    'git checkout HEAD -- a.txt',
    'git restore a.txt',
    'git reset --hard',
    'git stash',
    'git stash push -u',
    'git clean -fd',
  ]) {
    blocked(command);
  }
  for (const command of [
    'git status',
    'git diff a.txt',
    'git add b.txt', // only this session's subagent changed it
    'git commit -m "add a.txt and notes.txt"',
    'git checkout -b feature',
    'git restore --staged a.txt',
    'git clean -n',
    'git stash list',
    'echo git add -A',
    'AGENT_CHANGES_ALLOW=1 git add -A',
  ]) {
    allowed(command);
  }
});

test("the command line stages and discards one session's changes only", async () => {
  const dir = setupRepo();
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' });
  const other = { session_id: OTHER };
  edit(dir, {}, 'a.txt', 'line 2\n', 'line two\n');
  edit(dir, writer, 'b.txt', 'alpha\n', 'ALPHA\n');
  edit(dir, other, 'a.txt', 'line 9\n', 'line nine\n');
  toolCall(dir, other, 'Write', { file_path: path.join(dir, 'notes.txt'), content: 'n\n' }, () => fs.writeFileSync(path.join(dir, 'notes.txt'), 'n\n'));

  assert.match(cli('status', '--session', SESSION), /a\.txt {2}\(not staged\)[\s\S]*b\.txt[\s\S]*Other agents' changes[\s\S]*a\.txt, notes\.txt/);
  const out = cli('stage', '--session', SESSION);
  assert.match(out, /Staged this session's changes in: .*a\.txt/);
  assert.match(out, /Other agents' changes in a\.txt stay unstaged/);
  assert.equal(git('show', ':a.txt'), ten.replace('line 2\n', 'line two\n'), "only this session's line is staged");
  assert.equal(git('show', ':b.txt'), 'ALPHA\nbeta\n', "its subagent's work comes along");
  assert.equal(git('diff', '--cached', '--name-only').trim().split('\n').sort().join(','), 'a.txt,b.txt');
  git('commit', '-qm', 'Line two');
  assert.equal(read('a.txt'), ten.replace('line 2\n', 'line two\n').replace('line 9\n', 'line nine\n'), "the other session's line is still there");

  // The other session undoes its own work; what was committed stays.
  assert.match(cli('discard', '--session', OTHER), /Undid this session's changes in: a\.txt, notes\.txt/);
  assert.equal(read('a.txt'), ten.replace('line 2\n', 'line two\n'));
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), false);
  assert.match(cli('status', '--session', OTHER), /no uncommitted changes/);
  assert.equal(git('status', '--porcelain'), '');
});

test('the hook and the files it loads are copied together', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-changes-sync-'));
  assert.equal(syncHookFiles(path.join(__dirname, '..', '..'), dest), true);
  assert.equal(syncHookFiles(path.join(__dirname, '..', '..'), dest), false);
  for (const f of [HOOK_FILE, 'guard.js', 'cli.js', 'engine/tracker.js', 'engine/model.js', 'engine/git.js']) {
    assert.ok(fs.existsSync(path.join(dest, f)), f);
  }
});

test('installing the hook keeps existing settings and is idempotent', () => {
  const dir = setupRepo();
  const file = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(
    file,
    JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other' }] }] } }),
  );
  assert.equal(installHookSettings(dir, '/home/me/.claude/agent-changes/agent-changes-hook.js').changed, true);
  assert.equal(installHookSettings(dir, '/home/me/.claude/agent-changes/agent-changes-hook.js').changed, false);
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(s.permissions, { allow: ['Bash(ls:*)'] });
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'other');
  assert.equal(s.hooks.PostToolUse.length, 1);
  assert.equal(s.hooks.UserPromptSubmit[0].matcher, undefined);
  assert.equal(s.hooks.SessionStart.length, 1);
});

test('sessions are named after Claude Code session names, else a cleaned first prompt', async () => {
  const dir = setupRepo();
  const label = async () => {
    const snap = await (await Tracker.open(dir))!.compute();
    return snap.owners.find((o) => o.id === MAIN)!;
  };
  // Claude in Chrome prefixes prompts with an injected block; it must not become the name.
  hook(dir, {
    hook_event_name: 'UserPromptSubmit',
    prompt: '<browser_instruction>\n# Claude in Chrome browser automation\n...\n</browser_instruction>\nCompare receipt 3122 with 3123',
  });
  edit(dir, {}, 'a.txt', 'line 2\n', 'line two\n');
  assert.equal((await label()).label, 'Compare receipt 3122 with 3123');

  // Once Claude Code reports a session title (generated, -n, or /rename), it wins.
  hook(dir, { hook_event_name: 'UserPromptSubmit', prompt: 'next', session_title: 'Receipt parity check' });
  assert.equal((await label()).label, 'Receipt parity check');
  hook(dir, { hook_event_name: 'UserPromptSubmit', prompt: 'again', session_title: 'Receipt parity check' });
  hook(dir, { hook_event_name: 'SessionStart', session_title: 'Receipts v2' });
  assert.equal((await label()).label, 'Receipts v2');
  const sessions = fs
    .readFileSync(path.join(dir, '.git', 'agent-changes', 'log.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('"kind":"session"'));
  assert.equal(sessions.length, 3, 'an unchanged name is not logged again');
});

test('agent colors stay the same when new agents appear', async () => {
  const dir = setupRepo();
  edit(dir, writer, 'a.txt', 'line 2\n', 'line two\n');
  const tracker = (await Tracker.open(dir))!;
  const first = (await tracker.compute()).owners.find((o) => o.id === WRITER)!.color;
  edit(dir, {}, 'a.txt', 'line 5\n', 'line five\n');
  edit(dir, shell, 'b.txt', 'alpha\n', 'ALPHA\n');
  const snap = await tracker.compute();
  assert.equal(snap.owners.find((o) => o.id === WRITER)!.color, first);
  assert.equal(new Set(snap.owners.map((o) => o.color)).size, 3);
});

test('renaming a session relabels its group without waiting for a prompt', async () => {
  const dir = setupRepo();
  const transcript = path.join(dir, '..', `${path.basename(dir)}-transcript.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'make an md file saying hi.' } }) + '\n');
  hook(dir, { hook_event_name: 'UserPromptSubmit', prompt: 'make an md file saying hi.', transcript_path: transcript });
  edit(dir, {}, 'a.txt', 'line 2\n', 'line two\n');

  const tracker = (await Tracker.open(dir))!;
  const snap = await tracker.compute();
  const main = () => snap.owners.find((o) => o.id === MAIN)!;
  assert.equal(main().label, 'make an md file saying hi.');
  assert.equal(tracker.refreshTitles(snap), false);

  // Claude Code writes its generated title into the transcript; no hook fires.
  fs.appendFileSync(transcript, JSON.stringify({ type: 'ai-title', aiTitle: 'Create hi markdown file', sessionId: SESSION }) + '\n');
  assert.equal(tracker.refreshTitles(snap), true);
  assert.equal(main().label, 'Create hi markdown file');

  // /rename appends a custom title (verified shape); it wins, and later renames win again.
  fs.appendFileSync(transcript, JSON.stringify({ type: 'custom-title', customTitle: 'Greeting files', sessionId: SESSION }) + '\n');
  assert.equal(tracker.refreshTitles(snap), true);
  assert.equal(main().label, 'Greeting files');
  fs.appendFileSync(transcript, 'x'.repeat(10000) + '\n' + JSON.stringify({ type: 'custom-title', customTitle: 'Greeting files v2' }) + '\n');
  tracker.refreshTitles(snap);
  assert.equal(main().label, 'Greeting files v2');

  // A fresh tracker (VS Code reloaded) finds the same name.
  const again = await (await Tracker.open(dir))!.compute();
  assert.equal(again.owners.find((o) => o.id === MAIN)!.label, 'Greeting files v2');
});
