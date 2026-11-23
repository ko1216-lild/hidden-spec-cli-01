// mend: one patch tool for every AI edit format, as SPEC.md (in this repository) specifies.
//
// Reads a patch in one of four formats — a unified diff (whose line numbers may be wrong), SEARCH/REPLACE
// blocks, a V4A patch, or text-editor tool calls as JSON — finds the lines each edit names at the first of
// three matching tiers (exact; trailing whitespace ignored; leading and trailing whitespace ignored, with
// re-indentation), and writes every change or none. Node 22, the standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: exactly one line on standard output. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
/** One edit failed: a code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: what makes a path safe. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that ran, in order, as [old path, new path]; the report turns a pair into an R line. */
  moves: Array<readonly [string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A text file as lines, its own line break, and whether it ends with one (SPEC.md section 3). */
interface FileText {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    final = true;
    parts.pop();
  }
  return { lines: parts, br, final };
}

function writeFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line of a hunk, chunk or block body: context, old, new, or a `\` marker line. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** True when the entry came from an empty patch line (a body-end trim candidate). */
  emptyLine?: boolean;
}

const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every start position at or after `from` where `o` matches `lines` at `tier`; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** SPEC.md section 5: the first tier at which `o` occurs at or after `from`, and its positions there. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, o, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/**
 * Replace the matched lines at `pos` by a body's new side, in place. Context lines are written as the
 * file's own matched lines; at tier 2 every other new line is re-indented from the old side's first-line
 * prefix to the file's (SPEC.md section 5). Returns how many lines were written.
 */
function applyBody(f: FileText, pos: number, body: BodyLine[], tier: number): number {
  const firstOld = body.find((e) => e.kind === ' ' || e.kind === '-');
  const oLen = body.filter((e) => e.kind === ' ' || e.kind === '-').length;
  const F = leadWs(f.lines[pos] ?? '');
  const P = firstOld === undefined ? '' : leadWs(firstOld.text);
  const out: string[] = [];
  let oi = 0;
  for (const e of body) {
    if (e.kind === ' ') {
      out.push(f.lines[pos + oi]!);
      oi += 1;
    } else if (e.kind === '-') {
      oi += 1;
    } else if (e.kind === '+') {
      if (tier === 2 && e.text.trim() !== '' && e.text.startsWith(P)) out.push(F + e.text.slice(P.length));
      else out.push(e.text);
    }
  }
  f.lines.splice(pos, oLen, ...out);
  return out.length;
}

/** True when a `\` line immediately follows the body's last context or `+` line. */
function noBreakAfter(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') last = i;
  }
  return last >= 0 && body[last + 1]?.kind === '\\';
}

/** SPEC.md section 4: format detection for `--format=auto`. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk: its header's old-start A and its body lines. */
interface UHunk {
  a: number;
  body: BodyLine[];
}

/** A unified section while parsing: every way its two paths can be named, and its hunks. */
interface USection {
  gitOld?: string;
  gitNew?: string;
  minus?: string | null;
  plus?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

const GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `--- ` or `+++ ` header line names: after the four characters, to the first tab, trimmed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** SPEC.md section 6: read a unified diff into edits. Throws Exit2 on a parse fault. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let hunk: UHunk | null = null;
  let state: 'none' | 'header' | 'body' | 'after' = 'none';

  const endHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.emptyLine === true) hunk.body.pop();
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const endSection = (): void => {
    endHunk();
    if (sec !== null) sections.push(sec);
    sec = null;
  };
  const startGit = (line: string, num: number): void => {
    const m = GIT_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${num}`);
    sec = { gitOld: m[1]!, gitNew: m[2]!, newFile: false, delFile: false, hunks: [] };
    state = 'header';
  };
  const startPair = (i: number): void => {
    sec = { minus: headerPath(lines[i]!), plus: headerPath(lines[i + 1]!), newFile: false, delFile: false, hunks: [] };
    state = 'header';
  };
  const startHunk = (line: string, num: number): void => {
    const m = HUNK_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${num}`);
    hunk = { a: Number.parseInt(m[1]!, 10), body: [] };
    state = 'body';
  };
  const pairAt = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const num = i + 1;
    if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        endSection();
        startGit(line, num);
        continue;
      }
      if (pairAt(i)) {
        endSection();
        startPair(i);
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        endHunk();
        startHunk(line, num);
        continue;
      }
      const c = line[0];
      if (line === '') {
        hunk!.body.push({ kind: ' ', text: '', emptyLine: true });
        continue;
      }
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        hunk!.body.push({ kind: c, text: line.slice(1) });
        continue;
      }
      endHunk();
      state = 'after';
      continue;
    }
    if (state === 'header') {
      if (line.startsWith('diff --git ')) {
        endSection();
        startGit(line, num);
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (sec !== null && sec.minus === undefined) {
            sec.minus = headerPath(line);
            sec.plus = headerPath(lines[i + 1]!);
            i += 1;
            continue;
          }
          endSection();
          startPair(i);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${num + 1}`);
      }
      if (line.startsWith('+++ ')) {
        if (sec !== null && sec.plus === undefined) sec.plus = headerPath(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (sec !== null && sec.renameFrom === undefined) sec.renameFrom = line.slice(12);
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (sec !== null && sec.renameTo === undefined) sec.renameTo = line.slice(10);
        continue;
      }
      if (line.startsWith('new file mode')) {
        if (sec !== null) sec.newFile = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        if (sec !== null) sec.delFile = true;
        continue;
      }
      if (line.startsWith('@@')) {
        startHunk(line, num);
        continue;
      }
      continue;
    }
    if (state === 'after') {
      if (line.startsWith('diff --git ')) {
        endSection();
        startGit(line, num);
        continue;
      }
      if (pairAt(i)) {
        endSection();
        startPair(i);
        i += 1;
        continue;
      }
      if (line.startsWith('@@')) {
        startHunk(line, num);
        continue;
      }
      continue;
    }
    // state 'none': outside any section, prose is ignored until a section starts.
    if (line.startsWith('diff --git ')) {
      startGit(line, num);
      continue;
    }
    if (pairAt(i)) {
      startPair(i);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${num}`);
  }
  endSection();
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Turn one parsed unified section into its edit. */
function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.minus !== undefined ? s.minus : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
  const newPath = s.plus !== undefined ? s.plus : s.renameTo !== undefined ? s.renameTo : s.gitNew;
  const kind: 'create' | 'delete' | 'move' | 'change' =
    newPath === null ? 'delete' : oldPath === null ? 'create' : s.delFile ? 'delete' : s.newFile ? 'create' : oldPath !== newPath ? 'move' : 'change';
  return (tree) => {
    for (const p of [oldPath, newPath]) {
      if (typeof p === 'string' && !safe(p)) throw new Fail('unsafe', p);
    }
    if (kind === 'create') {
      const target = newPath as string;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const ls: string[] = [];
      for (const h of s.hunks) for (const e of h.body) if (e.kind === '+') ls.push(e.text);
      let fin = true;
      for (const h of s.hunks) if (h.body.some((e) => e.kind === '+')) fin = !noBreakAfter(h.body);
      tree.now.set(target, writeFile({ lines: ls, br: '\n', final: fin }));
      return;
    }
    if (kind === 'delete') {
      const target = oldPath as string;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const from = oldPath as string;
    const to = newPath as string;
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (kind === 'move' && tree.get(to) !== null) throw new Fail('exists', to);
    const f = parseFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const oTexts = h.body.filter((e) => e.kind === ' ' || e.kind === '-').map((e) => e.text);
      if (oTexts.length === 0) {
        const nTexts = h.body.filter((e) => e.kind === '+').map((e) => e.text);
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...nTexts);
        if (atEnd) f.final = !noBreakAfter(h.body);
        d += nTexts.length;
        continue;
      }
      const found = findTier(f.lines, oTexts, strict);
      if (found === null) throw new Fail('no-match', from);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.at) {
        const dd = Math.abs(p - target);
        if (dd < best) {
          best = dd;
          pos = p;
        }
      }
      const touchesEnd = pos + oTexts.length === f.lines.length;
      const written = applyBody(f, pos, h.body, found.tier);
      if (touchesEnd) f.final = !noBreakAfter(h.body);
      d += written - oTexts.length;
    }
    const text = writeFile(f);
    if (kind === 'move') {
      tree.now.set(from, null);
      tree.now.set(to, text);
      tree.moves.push([from, to] as const);
    } else {
      tree.now.set(to, text);
    }
  };
}

/** SPEC.md section 7: read SEARCH/REPLACE blocks into edits. Throws Exit2 on a parse fault. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let eq = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    let path: string | undefined;
    for (let j = at - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) {
      if (prevPath === undefined) throw new Exit2(`error: parse ${at + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(at + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, writeFile({ lines: [...newLines], br: '\n', final: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = parseFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    const body: BodyLine[] = [
      ...oldLines.map((t): BodyLine => ({ kind: '-', text: t })),
      ...newLines.map((t): BodyLine => ({ kind: '+', text: t })),
    ];
    applyBody(f, found.at[0]!, body, found.tier);
    tree.now.set(path, writeFile(f));
  };
}

/** One V4A chunk: an optional anchor, its body lines, and whether `*** End of File` closed it. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

/** One V4A section while parsing. */
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  add: BodyLine[];
  moveTo: string | null;
  chunks: VChunk[];
  touched: boolean;
}

/** SPEC.md section 8: read a V4A patch into edits. Throws Exit2 on a parse fault. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  let afterEof = false;

  const finish = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      while (cur.add.length > 0 && cur.add[cur.add.length - 1]!.emptyLine === true) cur.add.pop();
    }
    if (cur.kind === 'update') {
      const tail = cur.chunks[cur.chunks.length - 1];
      if (tail !== undefined) {
        while (tail.body.length > 0 && tail.body[tail.body.length - 1]!.emptyLine === true) tail.body.pop();
      }
      if (cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.line}`);
    }
    sections.push(cur);
    cur = null;
    chunk = null;
    afterEof = false;
  };

  for (let i = first + 1; i <= last; i += 1) {
    const line = lines[i]!;
    const num = i + 1;
    const t = line.trim();
    if (t === '*** End Patch') {
      finish();
      break;
    }
    if (line.startsWith('*** Add File:')) {
      finish();
      cur = { kind: 'add', path: line.slice(13).trim(), line: num, add: [], moveTo: null, chunks: [], touched: false };
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      finish();
      cur = { kind: 'delete', path: line.slice(16).trim(), line: num, add: [], moveTo: null, chunks: [], touched: false };
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      finish();
      cur = { kind: 'update', path: line.slice(16).trim(), line: num, add: [], moveTo: null, chunks: [], touched: false };
      continue;
    }
    if (line.startsWith('*** Move to:')) {
      if (cur !== null && cur.kind === 'update' && !cur.touched && cur.moveTo === null) {
        cur.moveTo = line.slice(12).trim();
        continue;
      }
      throw new Exit2(`error: parse ${num}`);
    }
    if (t === '*** End of File') {
      if (cur !== null && cur.kind === 'update' && chunk !== null) {
        chunk.eof = true;
        chunk = null;
        afterEof = true;
        cur.touched = true;
        continue;
      }
      throw new Exit2(`error: parse ${num}`);
    }
    if (line.startsWith('***')) throw new Exit2(`error: parse ${num}`);
    if (cur === null) {
      if (t === '') continue;
      throw new Exit2(`error: parse ${num}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) {
        cur.add.push({ kind: '+', text: line.slice(1) });
        cur.touched = true;
        continue;
      }
      if (t === '') {
        cur.add.push({ kind: '+', text: '', emptyLine: true });
        continue;
      }
      throw new Exit2(`error: parse ${num}`);
    }
    if (cur.kind === 'delete') {
      if (t === '') continue;
      throw new Exit2(`error: parse ${num}`);
    }
    // An Update File section: chunks of body lines.
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      cur.chunks.push(chunk);
      cur.touched = true;
      afterEof = false;
      continue;
    }
    const c = line[0];
    if (c === ' ' || c === '-' || c === '+') {
      if (chunk === null) {
        if (afterEof) throw new Exit2(`error: parse ${num}`);
        chunk = { anchor: null, eof: false, body: [] };
        cur.chunks.push(chunk);
      }
      // A whitespace-only line is a blank line (section 4): as a body line it is a context line with
      // empty text, and at the end of the section it is not part of it, so flag it for the trim in finish().
      chunk.body.push({ kind: c, text: line.slice(1), emptyLine: line.trim() === '' });
      cur.touched = true;
      continue;
    }
    if (t === '') {
      if (chunk !== null) {
        chunk.body.push({ kind: ' ', text: '', emptyLine: true });
        cur.touched = true;
      }
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  return sections.map((s) => v4aEdit(s, strict));
}

/** Turn one parsed V4A section into its edit. */
function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, writeFile({ lines: s.add.map((e) => e.text), br: '\n', final: true }));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = parseFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const foundAnchor = findTier(f.lines, [ch.anchor], strict, cursor);
        if (foundAnchor === null) throw new Fail('no-match', s.path);
        cursor = foundAnchor.at[0]! + 1;
      }
      const oTexts = ch.body.filter((e) => e.kind === ' ' || e.kind === '-').map((e) => e.text);
      if (oTexts.length === 0) {
        const nTexts = ch.body.filter((e) => e.kind === '+').map((e) => e.text);
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...nTexts);
        cursor = at + nTexts.length;
        continue;
      }
      const found = findTier(f.lines, oTexts, strict, cursor);
      if (found === null) throw new Fail('no-match', s.path);
      let pos = -1;
      for (const p of found.at) {
        if (!ch.eof || p + oTexts.length === f.lines.length) {
          pos = p;
          break;
        }
      }
      if (pos < 0) throw new Fail('no-match', s.path);
      const written = applyBody(f, pos, ch.body, found.tier);
      cursor = pos + written;
    }
    const text = writeFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      tree.moves.push([s.path, s.moveTo] as const);
    } else {
      tree.now.set(s.path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, 'A' | 'D' | 'M'>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  if (!check) {
    for (const p of changed.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows: { key: string; text: string }[] = [];
  const rest = new Map(changed);
  for (const [o, n] of tree.moves) {
    if (rest.get(o) === 'D' && rest.get(n) === 'A') {
      rest.delete(o);
      rest.delete(n);
      rows.push({ key: n, text: `R ${o} -> ${n}` });
    }
  }
  for (const [p, k] of rest) rows.push({ key: p, text: `${k} ${p}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
