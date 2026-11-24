import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreAll, mergeTargets, singleFlight } from '../orca/restore.mjs';
const sid = '01900000-0000-7000-8000-000000000001';
const target = { agent: 'codex', sessionId: sid, terminalId: 'saved-pane', workspacePath: '/project', hostId: 'local', title: 'Saved' };
function fixture(options = {}) {
  const calls = [];
  let mounted = false;
  let running = !!options.running;
  let pane = target.terminalId;
  const call = async (method, args) => {
    calls.push([method, args]);
    switch (method) {
      case 'workspace.readContext': return { workspaceId: 'original' };
      case 'workspace.list': return { truncated: !!options.partial, workspaces: [
        { id: 'workspace', path: '/project', hostId: options.host || 'local', name: 'Project', status: { terminalCount: 0 } },
      ] };
      case 'workspace.open': mounted = true; return { opened: true };
      case 'terminal.list': return { truncated: !!options.partialPanes, terminals: mounted && !options.closed ? [{ id: pane }] : [] };
      case 'terminal.focus': return { focused: true };
      case 'agents.list': return { agents: running && !options.closed ? [{ agent: 'codex', sessionId: sid, terminalId: pane }] : [] };
      case 'agent.resume':
        if (options.failure) throw Error('host unavailable');
        assert.equal(args.sessionId, sid);
        assert.equal(args.workspaceId, 'workspace');
        if (running) return { terminalId: pane, started: false };
        running = true; pane = 'recovered-pane';
        return { terminalId: pane, started: true };
      default: throw Error('Forbidden or unexpected action: ' + method);
    }
  };
  return { call, calls };
}
test('an unmounted workspace with zero live terminals still restores its saved conversation', async () => {
  const f = fixture(); const r = await restoreAll(f.call, [target]);
  assert.equal(r.resumed, 1); assert.equal(r.targets[0].terminalId, 'recovered-pane');
  assert.equal(f.calls.at(-1)[1].workspaceId, 'original');
});
test('repeated clicks reuse the running session and keep the new pane identity', async () => {
  const f = fixture(); const first = await restoreAll(f.call, [target]);
  const second = await restoreAll(f.call, first.targets);
  assert.equal(second.resumed, 0); assert.equal(second.alreadyRunning, 1);
});
test('a deliberately closed pane is not recreated', async () => {
  const f = fixture({ closed: true }); const r = await restoreAll(f.call, [target]);
  assert.equal(r.closed, 1); assert.equal(r.targets.length, 0);
  assert.ok(!f.calls.some(([m]) => m === 'agent.resume'));
});
test('an already running conversation is discovered without reading its messages', async () => {
  const f = fixture({ running: true }); const r = await restoreAll(f.call);
  assert.equal(r.alreadyRunning, 1); assert.equal(r.targets[0].sessionId, sid);
});
test('remote targets only match their own host', async () => {
  const f = fixture({ host: 'runtime:remote' });
  const remote = { ...target, hostId: 'runtime:remote' };
  const r = await restoreAll(f.call, [target, remote]);
  assert.equal(r.resumed, 1); assert.equal(r.errors.length, 1);
  assert.equal(r.targets.length, 2);
});
test('partial workspace inventory fails before any workspace changes', async () => {
  const f = fixture({ partial: true }); await assert.rejects(restoreAll(f.call, [target]), /일부만/);
  assert.ok(!f.calls.some(([m]) => m === 'workspace.open'));
});
test('partial terminal inventory preserves recovery data without launching', async () => {
  const f = fixture({ partialPanes: true }); const r = await restoreAll(f.call, [target]);
  assert.equal(r.errors.length, 1); assert.equal(r.targets.length, 1); assert.equal(r.resumed, 0);
});
test('failed resume is reported and not retried or counted as complete', async () => {
  const f = fixture({ failure: true }); const r = await restoreAll(f.call, [target]);
  assert.equal(r.errors.length, 1); assert.equal(r.resumed, 0); assert.equal(r.targets.length, 1);
  assert.equal(f.calls.filter(([m]) => m === 'agent.resume').length, 1);
});
test('rejects command-like ids and keeps the latest valid target per host/session', () => {
  assert.deepEqual(mergeTargets([target, { ...target, sessionId: '$(touch bad)' }], [{ ...target, terminalId: 'new' }]).map(t => t.terminalId), ['new']);
});
test('concurrent button presses share one operation and allow a later retry', async () => {
  let count = 0; let release;
  const run = singleFlight(async () => { count++; await new Promise(r => { release = r; }); return count; });
  const a = run(), b = run(); assert.equal(a, b);
  await Promise.resolve(); release(); await a;
  const c = run(); await Promise.resolve(); release(); await c;
  assert.equal(count, 2);
});
