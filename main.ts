import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

type Piece = { text: string; context?: number };
type Chunk = { old: string[]; next: Piece[]; at: number; anchor?: string; eof?: boolean; noBreak?: boolean };
type Edit = { path: string; dest?: string; kind: string; chunks?: Chunk[]; text?: string; old?: string; line?: number };
const parseFault = (line: number): never => { throw new Error(`parse ${line}`); };
function patchLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(s => s.replace(/\r$/, ''));
}
function unpack(text: string) {
  const first = text.indexOf('\n');
  const br = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  const end = text.endsWith(br);
  const lines = text ? text.split(br) : [];
  if (end) lines.pop();
  return { lines, br, end };
}
function pack(f: ReturnType<typeof unpack>): string {
  return f.lines.length ? f.lines.join(f.br) + (f.end ? f.br : '') : '';
}
function normalize(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');
}
function find(lines: string[], old: string[], strict: boolean, start = 0, eof = false) {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const positions: number[] = [];
    for (let i = start; i + old.length <= lines.length; i++) {
      if (eof && i + old.length !== lines.length) continue;
      if (old.every((s, j) => normalize(s, tier) === normalize(lines[i + j], tier))) positions.push(i);
    }
    if (positions.length) return { tier, positions };
  }
  throw new Error('no-match');
}
function replacement(lines: string[], c: Chunk, pos: number, tier: number): string[] {
  const from = c.old[0]?.match(/^[ \t]*/)?.[0] ?? '';
  const to = lines[pos]?.match(/^[ \t]*/)?.[0] ?? '';
  return c.next.map(p => {
    if (p.context !== undefined) return lines[pos + p.context];
    return tier === 2 && /[^ \t]/.test(p.text) && p.text.startsWith(from) ? to + p.text.slice(from.length) : p.text;
  });
}
function bodyLine(c: Chunk, s: string): void {
  const marker = s === '' ? ' ' : s[0];
  const text = s === '' ? '' : s.slice(1);
  if (marker === ' ') { c.next.push({ text, context: c.old.length }); c.old.push(text); }
  if (marker === '-') c.old.push(text);
  if (marker === '+') c.next.push({ text });
}
const chunk = (at = 0): Chunk => ({ old: [], next: [], at });

function readJson(text: string, lines: string[]): Edit[] {
  function convert(v: any, line: number): Edit {
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.path !== 'string') return parseFault(line);
    if (v.command === 'create' && typeof v.file_text === 'string') return { path: v.path, kind: 'create', text: v.file_text };
    if (v.command === 'str_replace' && typeof v.old_str === 'string' && v.old_str.length && (v.new_str === undefined || typeof v.new_str === 'string')) return { path: v.path, kind: 'string', old: v.old_str, text: v.new_str ?? '' };
    if (v.command === 'insert' && Number.isInteger(v.insert_line) && typeof v.new_str === 'string') return { path: v.path, kind: 'insert', line: v.insert_line, text: v.new_str };
    return parseFault(line);
  }
  const first = lines.findIndex(s => s.trim());
  if (text.trimStart().startsWith('[')) {
    try { const values = JSON.parse(text); if (!Array.isArray(values)) return parseFault(first + 1); return values.map(v => convert(v, first + 1)); }
    catch { return parseFault(first + 1); }
  }
  const edits: Edit[] = [];
  lines.forEach((s, i) => {
    if (!s.trim()) return;
    try { edits.push(convert(JSON.parse(s), i + 1)); } catch { parseFault(i + 1); }
  });
  return edits;
}
function readUnified(lines: string[]): Edit[] {
  type Section = { old: string; next: string; paired: boolean; add: boolean; del: boolean; chunks: Chunk[] };
  const sections: Section[] = [];
  let current: Section | undefined;
  const fresh = (old: string, next: string): Section => {
    const s = { old, next, paired: false, add: false, del: false, chunks: [] };
    sections.push(s); return s;
  };
  const clean = (s: string) => s.split('\t')[0].trim().replace(/^[ab]\//, '');
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    if (s.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(s);
      if (!m) parseFault(i + 1);
      current = fresh(m![1], m![2]);
    } else if (s.startsWith('--- ')) {
      if (!lines[i + 1]?.startsWith('+++ ')) { if (current && !current.chunks.length) parseFault(i + 2); continue; }
      if (!current || current.paired || current.chunks.length) current = fresh('', '');
      current.old = clean(s.slice(4)); current.next = clean(lines[++i].slice(4)); current.paired = true;
    } else if (s.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(s);
      if (!m || !current) parseFault(i + 1);
      const c = chunk(Number(m![1]));
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j];
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && lines[j + 1]?.startsWith('+++ '))) break;
        if (b !== '' && !/^[ +\-\\]/.test(b)) break;
        j++;
      }
      let end = j;
      while (end > i + 1 && lines[end - 1] === '') end--;
      let lastOutput = -1, marked = -2;
      for (let k = i + 1; k < end; k++) {
        const b = lines[k];
        if (b.startsWith('\\')) { if (k - 1 === lastOutput) marked = lastOutput; }
        else { bodyLine(c, b); if (b === '' || b[0] === ' ' || b[0] === '+') lastOutput = k; }
      }
      c.noBreak = lastOutput >= 0 && marked === lastOutput;
      current!.chunks.push(c); i = j - 1;
    } else if (current && !current.chunks.length) {
      if (s.startsWith('new file mode')) current.add = true;
      if (s.startsWith('deleted file mode')) current.del = true;
      if (!current.paired && s.startsWith('rename from ')) current.old = s.slice(12).trim();
      if (!current.paired && s.startsWith('rename to ')) current.next = s.slice(10).trim();
    }
  }
  return sections.map(s => {
    if (s.add || s.old === '/dev/null') {
      const added = s.chunks.flatMap(c => c.next.filter(p => p.context === undefined).map(p => p.text));
      let noBreak = false;
      for (const c of s.chunks) if (c.next.some(p => p.context === undefined)) noBreak = !!c.noBreak;
      return { kind: 'create', path: s.next, text: added.length ? added.join('\n') + (noBreak ? '' : '\n') : '' };
    }
    if (s.del || s.next === '/dev/null') return { kind: 'delete', path: s.old };
    return { kind: 'unified', path: s.old, dest: s.old !== s.next ? s.next : undefined, chunks: s.chunks };
  });
}
function readV4(lines: string[]): Edit[] {
  const first = lines.findIndex(s => s.trim());
  if (first < 0 || lines[first].trim() !== '*** Begin Patch') parseFault(first < 0 ? 1 : first + 1);
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (lines[last]?.trim() !== '*** End Patch') parseFault(lines.length + 1);
  const edits: Edit[] = [];
  for (let i = first + 1; i < last;) {
    if (!lines[i].trim()) { i++; continue; }
    const header = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(lines[i]);
    if (!header) parseFault(i + 1);
    const line = i + 1, path = header![2].trim(), command = header![1];
    let end = ++i;
    while (end < last && !/^\*\*\* (Add|Delete|Update) File: /.test(lines[end])) end++;
    let bodyEnd = end;
    while (bodyEnd > i && !lines[bodyEnd - 1].trim()) bodyEnd--;
    if (command === 'Add') {
      const content: string[] = [];
      for (; i < bodyEnd; i++) {
        if (lines[i] !== '' && !lines[i].startsWith('+')) parseFault(i + 1);
        content.push(lines[i].slice(1));
      }
      edits.push({ kind: 'create', path, text: content.length ? content.join('\n') + '\n' : '' });
    } else if (command === 'Delete') {
      if (i < bodyEnd) parseFault(i + 1);
      edits.push({ kind: 'delete', path });
    } else {
      const e: Edit = { kind: 'v4a', path, chunks: [] };
      if (lines[i]?.startsWith('*** Move to: ')) e.dest = lines[i++].slice(13).trim();
      let c: Chunk | undefined;
      for (; i < bodyEnd; i++) {
        const s = lines[i];
        if (s.startsWith('@@')) { c = chunk(); c.anchor = s.slice(2).trim() || undefined; e.chunks!.push(c); }
        else if (s === '*** End of File') {
          if (!c) parseFault(i + 1);
          c!.eof = true; c = undefined;
          if (i + 1 < bodyEnd) parseFault(i + 2);
        } else if (s === '' || /^[ +\-]/.test(s)) {
          if (!c) { c = chunk(); e.chunks!.push(c); }
          bodyLine(c, s);
        } else parseFault(i + 1);
      }
      if (!e.chunks!.length && e.dest === undefined) parseFault(line);
      edits.push(e);
    }
    i = end;
  }
  return edits;
}
function transform(e: Edit, text: string, strict: boolean): string {
  const f = unpack(text);
  if (e.kind === 'string') {
    const crlf = f.br === '\r\n';
    const norm = (s: string) => crlf ? s.replace(/\r\n/g, '\n') : s;
    const source = norm(text), old = norm(e.old!), next = norm(e.text!);
    const positions: number[] = [];
    for (let i = source.indexOf(old); i >= 0; i = source.indexOf(old, i + 1)) positions.push(i);
    if (!positions.length) throw new Error('no-match');
    if (positions.length > 1) throw new Error('ambiguous');
    const result = source.slice(0, positions[0]) + next + source.slice(positions[0] + old.length);
    return crlf ? result.replace(/\n/g, '\r\n') : result;
  }
  if (e.kind === 'insert') {
    if (e.line! < 0 || e.line! > f.lines.length) throw new Error('no-match');
    f.lines.splice(e.line!, 0, ...patchLines(e.text!)); return pack(f);
  }
  let delta = 0, cursor = 0;
  for (const c of e.chunks ?? []) {
    if (e.kind === 'v4a' && c.anchor) cursor = find(f.lines, [c.anchor], strict, cursor).positions[0] + 1;
    let pos: number, tier = 0;
    if (!c.old.length) pos = e.kind === 'unified' ? Math.max(0, Math.min(f.lines.length, c.at + delta)) : c.eof ? f.lines.length : cursor;
    else {
      const found = find(f.lines, c.old, strict, e.kind === 'v4a' ? cursor : 0, !!c.eof);
      tier = found.tier;
      if (e.kind === 'search' && found.positions.length > 1) throw new Error('ambiguous');
      pos = e.kind === 'unified' ? found.positions.reduce((best, p) => Math.abs(p - (c.at - 1 + delta)) < Math.abs(best - (c.at - 1 + delta)) ? p : best) : found.positions[0];
    }
    const atEnd = pos + c.old.length === f.lines.length;
    const next = replacement(f.lines, c, pos, tier);
    f.lines.splice(pos, c.old.length, ...next);
    if (e.kind === 'unified' && atEnd) f.end = !c.noBreak;
    delta += next.length - c.old.length; cursor = pos + next.length;
  }
  return pack(f);
}
function execute(edits: Edit[], check: boolean, strict: boolean): number {
  const original = new Map<string, string | null>(), state = new Map<string, string | null>();
  const get = (p: string): string | null => {
    if (!state.has(p)) {
      let text: string | null;
      try { text = readFileSync(p, 'utf8'); } catch { text = null; }
      original.set(p, text); state.set(p, text);
    }
    return state.get(p)!;
  };
  const moves: [string, string][] = [], errors: string[] = [];
  for (const e of edits) {
    let target = e.path;
    try {
      for (const p of e.dest === undefined ? [e.path] : [e.path, e.dest]) {
        target = p;
        if (!p || p.startsWith('/') || p.includes('\\') || p.split('/').some(s => !s || s === '.' || s === '..')) throw new Error('unsafe');
      }
      target = e.path;
      const before = get(e.path);
      if (e.kind === 'create') {
        if (before !== null) throw new Error('exists');
        state.set(e.path, e.text!); continue;
      }
      if (before === null) throw new Error('missing');
      if (e.dest !== undefined) {
        target = e.dest;
        if (get(e.dest) !== null) throw new Error('exists');
      }
      target = e.path;
      if (e.kind === 'delete') state.set(e.path, null);
      else {
        const after = transform(e, before, strict);
        state.set(e.dest ?? e.path, after);
        if (e.dest !== undefined) { state.set(e.path, null); moves.push([e.path, e.dest]); }
      }
    } catch (err) { errors.push(`error: ${(err as Error).message} ${target}`); }
  }
  if (errors.length) { process.stdout.write(errors.join('\n') + `\nfailed: ${errors.length} of ${edits.length} edits\n`); return 1; }
  const changed = [...state.keys()].filter(p => state.get(p) !== original.get(p));
  const output = new Map<string, string>();
  for (const p of changed) output.set(p, `${original.get(p) === null ? 'A' : state.get(p) === null ? 'D' : 'M'} ${p}`);
  for (const [old, dest] of moves) {
    if (original.get(old) !== null && state.get(old) === null && original.get(dest) === null && state.get(dest) !== null && output.has(old) && output.has(dest)) {
      output.delete(old); output.set(dest, `R ${old} -> ${dest}`);
    }
  }
  if (!check) {
    for (const p of changed) if (state.get(p) === null) unlinkSync(p);
    for (const p of changed) if (state.get(p) !== null) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, state.get(p)!); }
  }
  const sorted = [...output.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  process.stdout.write(sorted.map(p => output.get(p) + '\n').join('') + `ok: ${sorted.length} ${sorted.length === 1 ? 'file' : 'files'}\n`);
  return 0;
}
function cli(): number {
  let format = 'auto', check = false, strict = false, ended = false;
  const seen = new Set<string>(), paths: string[] = [];
  for (const arg of process.argv.slice(2)) {
    if (!ended && arg === '--') { ended = true; continue; }
    if (!ended && arg.startsWith('-') && arg !== '-') {
      const option = arg.startsWith('--format=') ? '--format' : arg;
      if (seen.has(option)) throw new Error('usage'); seen.add(option);
      if (option === '--format') format = arg.slice(9);
      else if (arg === '--check') check = true;
      else if (arg === '--strict') strict = true;
      else throw new Error('usage');
    } else paths.push(arg);
  }
  if (paths.length > 1 || !['auto', 'unified', 'search-replace', 'v4a', 'json'].includes(format)) throw new Error('usage');
  let text: string;
  try { text = readFileSync(!paths.length || paths[0] === '-' ? 0 : paths[0], 'utf8'); } catch { throw new Error('no-patch'); }
  const lines = patchLines(text), first = lines.find(s => s.trim())?.trim() ?? '';
  if (format === 'auto') {
    if (first === '*** Begin Patch') format = 'v4a';
    else if (/^[\[{]/.test(first)) format = 'json';
    else if (lines.some(s => s.trimEnd() === '<<<<<<< SEARCH')) format = 'search-replace';
    else if (lines.some((s, i) => s.startsWith('diff --git ') || (s.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')))) format = 'unified';
    else throw new Error('format');
  }
  const edits = format === 'json' ? readJson(text, lines) : format === 'unified' ? readUnified(lines) : format === 'v4a' ? readV4(lines) : readSearch(lines);
  if (!edits.length) parseFault(1);
  return execute(edits, check, strict);
}
if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  try { process.exitCode = cli(); }
  catch (err) { process.stdout.write(`error: ${(err as Error).message}\n`); process.exitCode = 2; }
}

function readSearch(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let boundary = 0, path: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') continue;
    const begin = i;
    for (let j = boundary; j < begin; j++) if (lines[j].trim() && !lines[j].trim().startsWith('```')) path = lines[j].trim();
    if (path === undefined) parseFault(begin + 1);
    const c = chunk();
    i++;
    while (i < lines.length && lines[i].trimEnd() !== '=======') c.old.push(lines[i++]);
    if (i === lines.length) parseFault(begin + 1);
    i++;
    while (i < lines.length && lines[i].trimEnd() !== '>>>>>>> REPLACE') c.next.push({ text: lines[i++] });
    if (i === lines.length) parseFault(begin + 1);
    edits.push({ path: path!, kind: c.old.length ? 'search' : 'create', chunks: [c], text: c.next.length ? c.next.map(p => p.text).join('\n') + '\n' : '' });
    boundary = i + 1;
  }
  return edits;
}
