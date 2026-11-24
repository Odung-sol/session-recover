const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = t => `${t.hostId || 'local'}\0${t.workspacePath}\0${t.sessionId}`;
export function validTarget(t) {
  return !!t && t.agent === 'codex' && UUID.test(t.sessionId || '')
    && typeof t.workspacePath === 'string' && t.workspacePath.startsWith('/')
    && typeof t.terminalId === 'string' && t.terminalId.length > 0
    && (t.hostId == null || typeof t.hostId === 'string');
}
export function mergeTargets(...groups) {
  const byKey = new Map();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const t of group) if (validTarget(t)) byKey.set(key(t), t);
  }
  return [...byKey.values()];
}
const samePane = (a, b) => a === b;

/** Only native Orca APIs: no shell commands, terminal input, prompts or process kills. */
export async function restoreAll(call, saved = []) {
  const context = await call('workspace.readContext', {});
  const inventory = await call('workspace.list', { includeStatus: true });
  if (inventory.truncated || inventory.statusTruncated) throw new Error('작업공간 목록이 일부만 반환돼 중단했습니다.');
  const targets = mergeTargets(saved);
  const report = { opened: 0, resumed: 0, alreadyRunning: 0, closed: 0, errors: [], targets: [] };
  const handled = new Set();
  try {
    for (const workspace of inventory.workspaces) {
      const own = targets.filter(t => t.workspacePath === workspace.path && (t.hostId || 'local') === (workspace.hostId || 'local'));
      try {
        // Zero live terminals does not imply zero saved panes. Mount before listing.
        await call('workspace.open', { workspaceId: workspace.id });
        const panes = await call('terminal.list', { workspaceId: workspace.id });
        if (panes.truncated) throw new Error('터미널 목록이 일부만 반환됐습니다.');
        for (const pane of panes.terminals) {
          try {
            const r = await call('terminal.focus', { terminalId: pane.id });
            if (r.focused) report.opened++;
            else report.errors.push({ name: pane.title || workspace.name, reason: '탭을 열지 못했습니다.' });
          } catch (error) { report.errors.push({ name: pane.title || workspace.name, reason: error.message }); }
        }
        const current = await call('agents.list', { workspaceId: workspace.id });
        const discovered = current.agents.map(a => ({ agent: a.agent, sessionId: a.sessionId,
          terminalId: a.terminalId, workspacePath: workspace.path, hostId: workspace.hostId || 'local',
          title: a.title || workspace.name }));
        const currentOwn = own.filter(t => !current.agents.some(a =>
          a.terminalId === t.terminalId && (a.agent !== t.agent || (a.sessionId && a.sessionId !== t.sessionId))));
        const candidates = mergeTargets(currentOwn, discovered);
        for (const target of candidates) {
          const id = key(target);
          if (handled.has(id)) continue;
          handled.add(id);
          // A deliberately closed pane is not a request to recreate its conversation.
          if (!panes.terminals.some(p => samePane(p.id, target.terminalId))) {
            report.closed++;
            continue;
          }
          try {
            const result = await call('agent.resume', {
              workspaceId: workspace.id, agent: target.agent, sessionId: target.sessionId,
            });
            if (!result.terminalId || typeof result.started !== 'boolean') throw new Error('재개 결과를 확인하지 못했습니다.');
            report.targets.push({ ...target, terminalId: result.terminalId });
            if (result.started) report.resumed++;
            else report.alreadyRunning++;
          } catch (error) {
            report.targets.push(target);
            report.errors.push({ name: target.title || workspace.name, reason: error.message });
          }
        }
      } catch (error) {
        report.targets.push(...own);
        report.errors.push({ name: workspace.name, reason: error.message });
      }
    }
    // An unavailable host/workspace must keep its recovery metadata for the next click.
    for (const target of targets) {
      if (!inventory.workspaces.some(w => w.path === target.workspacePath && (w.hostId || 'local') === (target.hostId || 'local'))) {
        report.targets.push(target);
        report.errors.push({ name: target.title || target.workspacePath, reason: '작업공간 연결을 확인할 수 없습니다.' });
      }
    }
  } finally {
    if (context?.workspaceId) {
      try { await call('workspace.open', { workspaceId: context.workspaceId }); }
      catch (error) { report.errors.push({ name: '원래 화면', reason: error.message }); }
    }
  }
  report.targets = mergeTargets(report.targets);
  return report;
}

export function describe(r) {
  let text = `탭 ${r.opened}개 열기 · 대화 ${r.resumed}개 재개 요청 · ${r.alreadyRunning}개 실행 중`;
  if (r.errors.length) text += ` · 확인 필요 ${r.errors.length}개: ` + r.errors.map(e => `${e.name}: ${e.reason}`).join('; ');
  return text + '. 로그인·hook 확인·다른 앱의 대화 잠금은 해당 탭에서 확인하세요.';
}

export function singleFlight(fn) {
  let pending = null;
  return () => {
    if (!pending) pending = Promise.resolve().then(fn).finally(() => { pending = null; });
    return pending;
  };
}
