import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { restoreAll, describe, mergeTargets, singleFlight } from './restore.mjs';

async function seedTargets() {
  try {
    const text = await readFile(join(homedir(), '.local/share/session-recover/orca-targets.json'), 'utf8');
    if (text.length > 262144) throw new Error('복구 목록이 너무 큽니다.');
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('복구 목록 형식이 올바르지 않습니다.');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export default function activate(orca) {
  const call = (name, params) => orca.host.call(name, params, { signal: AbortSignal.timeout(20000) });
  const run = singleFlight(async () => {
    await call('statusBar.update', { id: 'restore-all', text: '대화 복구 중…', tone: 'accent' });
    try {
      const stored = await orca.storage.get('targets-v1');
      // A saved empty list means the user closed all tracked panes: do not reseed it.
      const targets = stored == null ? mergeTargets(await seedTargets()) : mergeTargets(stored);
      const result = await restoreAll(call, targets);
      await orca.storage.set('targets-v1', result.targets);
      const message = describe(result);
      await call('statusBar.update', { id: 'restore-all', text: '전체 대화 복구',
        tone: result.errors.length ? 'warning' : 'success', tooltip: message });
      return message;
    } catch (error) {
      await call('statusBar.update', { id: 'restore-all', text: '전체 대화 복구', tone: 'warning', tooltip: error.message });
      return `복구 중단: ${error.message}`;
    }
  });
  orca.commands.register('restore-all', run);
}
