import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
const exec = promisify(execFile);
const CLI = '/Applications/Orca.app/Contents/Resources/bin/orca';

export async function cli(args, environment = 'local') {
  let stdout;
  try { ({ stdout } = await exec(CLI, [...args, ...(environment ? ['--environment', environment] : []), '--json'], { timeout: 25000, maxBuffer: 8 * 1024 * 1024 })); }
  catch (error) {
    try { const d = JSON.parse(error.stdout); throw new Error(d.error?.message || 'Orca 요청 실패'); }
    catch (parsed) { if (parsed instanceof SyntaxError) throw new Error('Orca 응답을 확인하지 못했습니다.'); throw parsed; }
  }
  const d = JSON.parse(stdout);
  if (!d.ok) throw new Error(d.error?.message || 'Orca 요청 실패');
  if (d.result.truncated) throw new Error('목록이 일부만 반환됐습니다.');
  return d.result;
}

export function parseSavedRows(rows) {
  const tabs = new Map(), layouts = new Map(), sleeping = new Map(), panes = [];
  for (const row of rows) {
    const path = JSON.parse(row.part_key), value = JSON.parse(row.payload);
    if (row.domain === 'workspaceSession') {
      if (path[0] === 'tabsByWorktree') tabs.set(path[1], value);
      if (path[0] === 'terminalLayoutsByTabId') layouts.set(path[1], value);
      if (path[0] === 'sleepingAgentSessionsByPaneKey') sleeping.set(path[1], value);
    } else if (row.domain === 'remoteLayoutSnapshots') {
      for (const t of value.tabs || []) {
        if (t.type !== 'terminal' || !t.ptyId) continue;
        panes.push({ hostId: `runtime:${path[0]}`, workspacePath: path[2]?.split('::').slice(1).join('::'),
          terminalId: t.ptyId, title: t.customTitle || t.title, agent: t.agentStatus?.agentType || t.launchAgent,
          sessionId: t.agentStatus?.providerSession?.id });
      }
    }
  }
  for (const [worktreeId, list] of tabs) for (const tab of list) {
    const layout = layouts.get(tab.id);
    const leaves = layout?.ptyIdsByLeafId || { '': tab.ptyId };
    for (const [leafId, terminalId] of Object.entries(leaves)) {
      const previous = sleeping.get(`${tab.id}:${leafId}`);
      // A tab title belongs to its primary pane, never to every split pane.
      const titleSession = terminalId === tab.ptyId ? tab.aiVaultTitle : null;
      panes.push({ hostId: 'local', workspacePath: worktreeId.split('::').slice(1).join('::'), terminalId,
        title: tab.customTitle || tab.title, agent: previous?.agent || titleSession?.agent,
        sessionId: previous?.providerSession?.id || titleSession?.sessionId });
    }
  }
  return panes.filter(p => p.terminalId && p.workspacePath?.startsWith('/'));
}

export async function savedPanes() {
  // This is a read-only snapshot of the active default profile, not the stale JSON export.
  const db = join(homedir(), 'Library/Application Support/Orca/profiles/local-default/profile-state.db');
  const sql = `SELECT domain,part_key,payload FROM profile_state_document_parts
    WHERE (domain='workspaceSession' AND json_extract(part_key,'$[0]') IN
      ('tabsByWorktree','terminalLayoutsByTabId','sleepingAgentSessionsByPaneKey'))
    OR domain='remoteLayoutSnapshots';`;
  const { stdout } = await exec('/usr/bin/sqlite3', ['-readonly', '-json', db, sql], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  return parseSavedRows(JSON.parse(stdout || '[]'));
}

export function createAdapter(call) {
  return {
    context: () => call('workspace.readContext', {}),
    returnTo: context => context?.workspaceId ? call('workspace.open', { workspaceId: context.workspaceId }) : undefined,
    snapshot: savedPanes,
    async hosts() {
      const { environments } = await cli(['environment', 'list'], null);
      return [{ id: 'local', environment: 'local' }, ...environments.map(e => ({ id: `runtime:${e.id}`, environment: e.id }))];
    },
    async workspaces(host) {
      const r = await cli(['worktree', 'list'], host.environment);
      const native = host.id === 'local' ? await call('workspace.list', {}) : { workspaces: [] };
      if (native.truncated) throw new Error('작업공간 목록이 일부만 반환됐습니다.');
      return r.worktrees.map(w => ({ id: w.id, path: w.path, name: w.displayName || w.path,
        nativeId: native.workspaces.find(n => n.path === w.path && (n.hostId || 'local') === 'local')?.id }));
    },
    async wake(host, workspace) {
      await cli(['serve', 'restore', 'resume'], host.environment);
      await cli(['worktree', 'activate', '--worktree', `id:${workspace.id}`], host.environment);
    },
    async live(host, workspace) {
      return (await cli(['terminal', 'list', '--worktree', `id:${workspace.id}`], host.environment)).terminals;
    },
    async focus(host, pane) { await cli(['terminal', 'switch', '--terminal', pane.handle], host.environment); },
    async discover(host, workspace, live) {
      if (host.id !== 'local' || !workspace.nativeId) return [];
      const { agents } = await call('agents.list', { workspaceId: workspace.nativeId });
      return agents.flatMap(a => {
        const pane = live.find(p => p.handle === a.terminalId);
        return pane?.agentIdentity === 'codex' ? [{ hostId: host.id, workspacePath: workspace.path, terminalId: pane.ptyId,
          agent: a.agent, sessionId: a.sessionId, title: a.title }] : [];
      });
    },
    async resume(host, workspace, target) {
      if (host.id === 'local') {
        if (!workspace.nativeId) throw new Error('오르카 작업공간 식별자를 확인하지 못했습니다.');
        const r = await call('agent.resume', { workspaceId: workspace.nativeId, agent: 'codex', sessionId: target.sessionId });
        return { handle: r.terminalId, started: r.started };
      }
      // Only a UUID is interpolated, into a new terminal; existing input is never touched.
      const r = await cli(['terminal', 'create', '--worktree', `id:${workspace.id}`,
        '--command', `codex resume ${target.sessionId}`, '--title', target.title || '복구한 대화', '--focus'], host.environment);
      return { handle: r.terminal?.handle || r.handle, started: true };
    },
  };
}
