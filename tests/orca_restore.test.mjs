import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreAll, mergeTargets, singleFlight } from '../orca/restore.mjs';
import { parseSavedRows } from '../orca/adapter.mjs';
const sid = '01900000-0000-7000-8000-000000000001';
const target = { agent: 'codex', sessionId: sid, terminalId: 'saved-pty', workspacePath: '/project', hostId: 'local', title: 'Saved' };
function fixture(options = {}) {
  const calls = [], saves = [];
  let running = !!options.running, pty = target.terminalId;
  const host = options.host || 'local';
  const api = {
    context: async () => ({ workspaceId: 'original' }),
    returnTo: async c => calls.push(['returnTo', c]),
    snapshot: async () => {
      if (options.snapshotFailure) throw Error('unavailable');
      return options.closed ? [] : [{ ...target, hostId: host }];
    },
    hosts: async () => [{ id: host }],
    workspaces: async () => [{ id: 'workspace', path: '/project', name: 'Project' }, { id: 'empty', path: '/empty' }],
    wake: async (h,w) => { calls.push(['wake', w]); if (options.autoRestore) running = true; },
    live: async () => {
      if (options.partial) throw Error('partial inventory');
      return [{ ptyId: pty, handle: `runtime-${pty}`, agentIdentity: running ? 'codex' : null }];
    },
    focus: async () => calls.push(['focus']),
    discover: async () => [],
    resume: async (h,w,t) => {
      calls.push(['resume', t]);
      if (options.failure) throw Error('unknown delivery');
      assert.equal(t.sessionId, sid);
      running = true; pty = 'new-stable-pty';
      return { handle: `runtime-${pty}`, started: true };
    },
  };
  const save = async rows => saves.push(structuredClone(rows));
  return { api, calls, saves, save };
}
test('already running Codex is never resumed even if native resume is not idempotent', async () => {
  const f = fixture({ running: true }); const r = await restoreAll(f.api, [target], f.save);
  assert.equal(r.alreadyRunning, 1); assert.equal(r.resumed, 0);
  assert.ok(!f.calls.some(([m]) => m === 'resume'));
});
test('cold saved workspace is opened, and automatic restoration is detected', async () => {
  const f = fixture({ autoRestore: true }); const r = await restoreAll(f.api, [target], f.save);
  assert.equal(r.alreadyRunning, 1); assert.equal(r.resumed, 0);
});
test('exited conversation resumes once and persists stable PTY, not runtime handle', async () => {
  const f = fixture(); const r = await restoreAll(f.api, [target], f.save);
  assert.equal(r.resumed, 1); assert.equal(r.targets[0].terminalId, 'new-stable-pty');
  assert.equal(f.saves[0][0].pending, true);
  assert.equal(f.saves.at(-1)[0].pending, false);
  assert.equal(f.calls.at(-1)[0], 'returnTo');
});
test('a second click reuses the recovered terminal', async () => {
  const f = fixture(); const first = await restoreAll(f.api, [target], f.save);
  const second = await restoreAll(f.api, first.targets, f.save);
  assert.equal(second.resumed, 0); assert.equal(second.alreadyRunning, 1);
  assert.equal(f.calls.filter(([m]) => m === 'resume').length, 1);
});
test('empty workspaces are never opened and never create default blank tabs', async () => {
  const f = fixture({ running: true }); await restoreAll(f.api, [target]);
  assert.deepEqual(f.calls.filter(([m]) => m === 'wake').map(([,w]) => w.path), ['/project']);
});
test('deliberately closed panes stay closed', async () => {
  const f = fixture({ closed: true }); const r = await restoreAll(f.api, [target]);
  assert.equal(r.closed, 1); assert.ok(!f.calls.some(([m]) => ['resume','wake'].includes(m)));
});
test('lost response is journaled and never blindly retried on a later click', async () => {
  const f = fixture({ failure: true }); const a = await restoreAll(f.api, [target], f.save);
  assert.equal(a.errors.length, 1); assert.equal(a.targets[0].pending, true);
  const b = await restoreAll(f.api, a.targets, f.save);
  assert.equal(b.resumed, 0); assert.equal(b.errors.length, 1);
  assert.equal(f.calls.filter(([m]) => m === 'resume').length, 1);
});
test('a failed journal write prevents a launch', async () => {
  const f = fixture(); await restoreAll(f.api, [target], async () => { throw Error('disk full'); }).catch(()=>{});
  assert.ok(!f.calls.some(([m]) => m === 'resume'));
});
test('unavailable saved-tab state aborts before waking anything', async () => {
  const f = fixture({ snapshotFailure: true }); await assert.rejects(restoreAll(f.api, [target]));
  assert.equal(f.calls.length, 0);
});
test('partial terminal inventory never starts an agent or loses its target', async () => {
  const f = fixture({ partial: true }); const r = await restoreAll(f.api, [target]);
  assert.equal(r.targets.length, 1); assert.equal(r.resumed, 0); assert.equal(r.errors.length, 1);
});
test('remote and local identical paths remain separate', async () => {
  const f = fixture({ host: 'runtime:remote', running: true });
  const r = await restoreAll(f.api, [target, { ...target, hostId: 'runtime:remote' }]);
  assert.equal(r.alreadyRunning, 1); assert.equal(r.errors.length, 1); assert.equal(r.targets.length, 2);
});
test('invalid session IDs cannot become shell text', () => {
  assert.deepEqual(mergeTargets([{ ...target, sessionId: '$(touch bad)' }]), []);
});
test('a changed conversation in a pane supersedes its old session', async () => {
  const f = fixture({ running: true }); const changed = { ...target, sessionId: sid.slice(0,-1)+'2' };
  f.api.snapshot = async () => [changed];
  const r = await restoreAll(f.api, [target]);
  assert.deepEqual(r.targets.map(t=>t.sessionId), [changed.sessionId]);
});
test('concurrent button presses share one run', async () => {
  let count = 0, release;
  const run = singleFlight(async () => { count++; await new Promise(r => { release = r; }); });
  const a = run(), b = run(); assert.equal(a,b); await Promise.resolve(); release(); await a;
  const c = run(); await Promise.resolve(); release(); await c; assert.equal(count,2);
});
const row = (domain,path,payload) => ({ domain, part_key: JSON.stringify(path), payload: JSON.stringify(payload) });
test('saved pane parser uses current SQLite parts and isolates split pane session IDs', () => {
  const rows = [
    row('workspaceSession',['tabsByWorktree','repo::/project'],[{ id:'tab',ptyId:'primary',aiVaultTitle:{agent:'codex',sessionId:sid} }]),
    row('workspaceSession',['terminalLayoutsByTabId','tab'],{ ptyIdsByLeafId:{a:'primary',b:'split'} }),
  ];
  const panes = parseSavedRows(rows); assert.equal(panes.length,2);
  assert.equal(panes[0].sessionId,sid); assert.equal(panes[1].sessionId,undefined);
});
test('captured provider ID takes precedence over an older title session', () => {
  const rows = [
    row('workspaceSession',['tabsByWorktree','repo::/project'],[{ id:'tab',ptyId:'primary',aiVaultTitle:{agent:'codex',sessionId:'old'} }]),
    row('workspaceSession',['terminalLayoutsByTabId','tab'],{ ptyIdsByLeafId:{a:'primary'} }),
    row('workspaceSession',['sleepingAgentSessionsByPaneKey','tab:a'],{ agent:'codex',providerSession:{id:sid} }),
  ];
  assert.equal(parseSavedRows(rows)[0].sessionId,sid);
});
test('paired remote snapshot is scoped to environment, not remote local host ID', () => {
  const p = parseSavedRows([row('remoteLayoutSnapshots',['remote','workspaces','repo::/project'],{ tabs:[
    {type:'terminal',ptyId:'remote-pty',agentStatus:{agentType:'codex',providerSession:{id:sid}}},
    {type:'browser',id:'browser'},
  ] })]);
  assert.equal(p.length,1); assert.equal(p[0].hostId,'runtime:remote'); assert.equal(p[0].sessionId,sid);
});
test('stale snapshot entries from removed workspaces do not become recovery targets', async () => {
  const f = fixture({ running: true });
  f.api.snapshot = async () => [target, { ...target, workspacePath:'/removed',terminalId:'old' }];
  const r = await restoreAll(f.api, [target]);
  assert.equal(r.targets.length,1); assert.equal(r.errors.length,0);
});
