const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = t => `${t.hostId || 'local'}\0${t.workspacePath}\0${t.sessionId}`;
const samePlace = (t, host, workspace) => (t.hostId || 'local') === host.id && t.workspacePath === workspace.path;
export function validTarget(t) {
  return !!t && t.agent === 'codex' && UUID.test(t.sessionId || '')
    && typeof t.workspacePath === 'string' && t.workspacePath.startsWith('/')
    && typeof t.terminalId === 'string' && t.terminalId.length > 0
    && (t.hostId == null || typeof t.hostId === 'string');
}
export function mergeTargets(...groups) {
  const byKey = new Map();
  for (const group of groups) if (Array.isArray(group)) for (const t of group) if (validTarget(t)) byKey.set(key(t), t);
  return [...byKey.values()];
}

export async function restoreAll(api, saved = [], save = async () => {}) {
  const context = await api.context();
  const snapshot = await api.snapshot(); // Fails before changes if saved-tab state is unavailable.
  let targets = mergeTargets(saved);
  const report = { opened: 0, resumed: 0, alreadyRunning: 0, closed: 0, errors: [], targets };
  const handled = new Set();
  const update = async target => {
    targets = mergeTargets(targets, [target]); report.targets = targets;
    await save(targets);
  };
  try {
    for (const host of await api.hosts()) {
      try {
        for (const workspace of await api.workspaces(host)) {
          const panes = snapshot.filter(p => samePlace(p, host, workspace));
          // Stale saved tabs from removed workspaces are not new recovery targets.
          targets = mergeTargets(panes, targets);
          let own = targets.filter(t => samePlace(t, host, workspace));
          for (const t of own) handled.add(key(t));
          if (!panes.length) { report.closed += own.length; continue; }
          try {
            await api.wake(host, workspace);
            let live = await api.live(host, workspace);
            const discovered = await api.discover(host, workspace, live);
            // A new session in the same pane supersedes its previous recovery record.
            for (const t of [...panes, ...discovered].filter(validTarget)) {
              targets = targets.filter(old => !(samePlace(old, host, workspace)
                && old.terminalId === t.terminalId && old.sessionId !== t.sessionId && !old.pending));
            }
            // Current metadata wins for a pane; retain replacement identity and uncertain requests.
            targets = mergeTargets(targets, discovered);
            own = targets.filter(t => samePlace(t, host, workspace));
            for (const pane of live) {
              await api.focus(host, pane); report.opened++;
            }
            for (const target of own) {
              handled.add(key(target));
              const exists = panes.some(p => p.terminalId === target.terminalId);
              let pane = live.find(p => p.ptyId === target.terminalId);
              if (pane?.agentIdentity) {
                if (pane.agentIdentity === 'codex') report.alreadyRunning++;
                else report.errors.push({ name: target.title, reason: '다른 프로그램이 실행 중입니다.' });
                await update({ ...target, pending: false });
                continue;
              }
              if (!exists) { report.closed++; continue; }
              if (target.pending) {
                report.errors.push({ name: target.title, reason: '이전 재개 결과가 불확실해 중복 실행을 막았습니다.' });
                continue;
              }
              // Recheck immediately before launching: opening a workspace can auto-restore later.
              live = await api.live(host, workspace);
              pane = live.find(p => p.ptyId === target.terminalId);
              if (pane?.agentIdentity) {
                if (pane.agentIdentity === 'codex') report.alreadyRunning++;
                else report.errors.push({ name: target.title, reason: '다른 프로그램이 실행 중입니다.' });
                continue;
              }
              await update({ ...target, pending: true });
              try {
                const result = await api.resume(host, workspace, target);
                if (!result.handle || typeof result.started !== 'boolean') throw new Error('재개 응답을 확인하지 못했습니다.');
                const after = await api.live(host, workspace);
                const restored = after.find(p => p.handle === result.handle);
                if (!restored) throw new Error('재개한 탭을 아직 확인하지 못했습니다.');
                await update({ ...target, terminalId: restored.ptyId, sourceTerminalId: target.sourceTerminalId || target.terminalId, pending: false });
                if (result.started) report.resumed++; else report.alreadyRunning++;
              } catch (error) { report.errors.push({ name: target.title, reason: error.message }); }
            }
          } catch (error) { report.errors.push({ name: workspace.name, reason: error.message }); }
        }
      } catch (error) { report.errors.push({ name: host.id, reason: error.message }); }
    }
    for (const t of targets) if (!handled.has(key(t))) report.errors.push({ name: t.title || t.workspacePath, reason: '작업공간 연결을 확인할 수 없습니다.' });
  } finally {
    try { await api.returnTo(context); }
    catch (error) { report.errors.push({ name: '원래 화면', reason: error.message }); }
  }
  report.targets = targets;
  await save(targets);
  return report;
}

export function describe(r) {
  let text = `탭 ${r.opened}개 확인 · 대화 ${r.resumed}개 재개 요청 · ${r.alreadyRunning}개 실행 감지`;
  if (r.errors.length) text += ` · 확인 필요 ${r.errors.length}개: ` + r.errors.map(e => `${e.name || '대화'}: ${e.reason}`).join('; ');
  return text + '. 로그인·hook·다른 앱의 대화 잠금은 해당 탭에서 확인하세요.';
}
export function singleFlight(fn) {
  let pending = null;
  return () => {
    if (!pending) pending = Promise.resolve().then(fn).finally(() => { pending = null; });
    return pending;
  };
}
