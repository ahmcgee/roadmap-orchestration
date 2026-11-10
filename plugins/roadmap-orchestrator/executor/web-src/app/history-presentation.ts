import { fileLines, shellWritePath } from './file-history.ts';
const input = (event: any) => { try { return JSON.parse(event.input); } catch { return null; } };
/** Ignore shell comments only where quoting and expansion cannot change their meaning. */
function commandIdentity(command: string) {
  if (/[$`]|<<|\\\n/.test(command)) return command;
  let quote = '', escaped = false, result = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (escaped) { result += c; escaped = false; continue; }
    if (c === '\\' && quote !== "'") { result += c; escaped = true; continue; }
    if (quote) { result += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; result += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(command[i - 1]!))) {
      while (i < command.length && command[i] !== '\n') i++;
      if (i < command.length) result += '\n';
    } else result += c;
  }
  return result.trim();
}
export function historyGroups(events: any[], live: boolean) {
  const groups: { key: string; events: any[]; signature: string | null; label: string }[] = [];
  for (const [index, event] of events.entries()) {
    const data = input(event), command = data?.command;
    const groupable = event.type === 'tool' && ['Bash', 'Command'].includes(event.tool) && typeof command === 'string' && event.status === 'passed' && !event.truncated?.length && !(live && index === events.length - 1) && !shellWritePath(command) && !/<<|\btee\b|\bsed\s+-[a-z]*i|writeFile|write_text|write_bytes|open\(/.test(command);
    const signature = groupable ? JSON.stringify([event.parent, event.tool, { ...data, command: commandIdentity(command) }]) : null, last = groups.at(-1);
    if (signature && last?.signature === signature) last.events.push(event);
    else groups.push({ key: event.id, events: [event], signature, label: data?.description || command?.split('\n')[0] || event.title || event.tool });
  }
  return groups;
}
/** Consecutive successful commands with the same recorded purpose share a disclosure.
 * File writes, incomplete input and failures stay outside it so their evidence stays visible. */
export function historyToolRuns(events: any[], live: boolean) {
  const runs: ReturnType<typeof historyGroups> = [];
  for (const group of historyGroups(events, live)) {
    const previous=runs.at(-1),first=group.events[0],last=previous?.events.at(-1);
    if(group.signature&&previous?.signature&&group.label===previous.label&&first.parent===last.parent) previous.events.push(...group.events);
    else runs.push({...group,events:[...group.events]});
  }
  return runs;
}
/** This is an index of retained history evidence, not a worktree diff or a session total. */
export function changedFiles(events: any[], views: Map<string, any>) {
  const files = new Map<string, { path: string; id: string; added: number; removed: number; counts: boolean }>();
  for (const event of events) {
    if (event.type !== 'tool' || event.status !== 'passed') continue;
    const data = input(event), shell = ['Bash', 'Command'].includes(event.tool), path = ['Edit', 'MultiEdit', 'Write'].includes(event.tool) ? data?.file_path || data?.path : shell ? shellWritePath(data?.command || '') : null;
    if (typeof path !== 'string' || !path) continue;
    const view = views.get(event.id), diff = view?.diff, old = files.get(path), created = event.tool === 'Write' && view?.kind === 'create';
    files.set(path, { path, id: old && views.get(old.id)?.diff ? old.id : diff ? event.id : old?.id || event.id, added: (old?.added || 0) + (diff?.added ?? (created ? fileLines(data.content || '').length : 0)), removed: (old?.removed || 0) + (diff?.removed || 0), counts: !!((old ? old.counts : true) && (diff || created)) });
  }
  return [...files.values()];
}
