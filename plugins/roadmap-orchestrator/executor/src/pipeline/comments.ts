// Which lines of a source file are whole-line comments, read by a lexer pass over the whole file (dev.17, proportional
// review: src/pipeline/docsonly.ts clears a comment-only hunk without the verifier only on this reading).
//
// Fail-safe: code may clear a line only when it is certain the line is a comment (or a blank line) in plain code. So each
// lexer tracks the constructs that make a comment-looking line something else: a line inside a string that spans lines
// (a template literal, a raw string, a triple-quoted string, an escaped newline) is no comment. A lexer that meets a
// construct it does not model with certainty (a slash that may open a JavaScript regular expression followed by a quote, a
// Python f-string field holding a quote, an unterminated string, JSX in a JavaScript file, cgo's C preamble) reads the whole
// file as unknown (null), and the caller asks the verifier. Only the languages here have a lexer; every other file
// (configuration files among them: YAML, TOML, INI, JSON5, whose comments tools may read; shell, whose heredocs this does
// not model; Rust, Java, C and the rest) is unknown.

/** What a line is at its start: blank or a whole-line comment in plain code, or anything else. */
export type LineKind = 'blank' | 'comment' | 'other';

type Lexer = (text: string) => readonly boolean[] | null;

/**
 * The language of each file extension the docs-only reading names to the verifier, and its lexer when code may read its
 * comments (`prefix`: its line comment).
 */
const LANGUAGES: Readonly<Record<string, Readonly<{ language: string; lexer: Readonly<{ prefix: string; lex: Lexer }> | null }>>> = (() => {
  const known = (language: string) => ({ language, lexer: null });
  const ts = { language: 'TypeScript', lexer: { prefix: '//', lex: (t: string) => lexJs(t, false) } };
  const js = { language: 'JavaScript', lexer: { prefix: '//', lex: (t: string) => lexJs(t, true) } };
  return {
    ts, mts: ts, cts: ts, js, mjs: js, cjs: js, tsx: known('TypeScript JSX'), jsx: known('JavaScript JSX'),
    go: { language: 'Go', lexer: { prefix: '//', lex: lexGo } }, py: { language: 'Python', lexer: { prefix: '#', lex: lexPython } },
    rs: known('Rust'), java: known('Java'), kt: known('Kotlin'), scala: known('Scala'), swift: known('Swift'), c: known('C'), h: known('C'),
    cc: known('C++'), cpp: known('C++'), hpp: known('C++'), cs: known('C#'), dart: known('Dart'), rb: known('Ruby'), sh: known('shell'),
    bash: known('shell'), zsh: known('shell'), yaml: known('YAML'), yml: known('YAML'), toml: known('TOML'), ini: known('INI'),
    cfg: known('INI'), json5: known('JSON5'), jsonc: known('JSON with comments'), r: known('R'), pl: known('Perl'), ex: known('Elixir'),
    exs: known('Elixir'), sql: known('SQL'), lua: known('Lua'), hs: known('Haskell'),
  };
})();

const extensionOf = (path: string): string | null => {
  const dot = path.lastIndexOf('.');
  return dot <= path.lastIndexOf('/') ? null : path.slice(dot + 1).toLowerCase();
};

/** The language a path's extension names (for the verifier), or null when it is none known. */
export function languageOf(path: string): string | null {
  const ext = extensionOf(path);
  return ext === null ? null : LANGUAGES[ext]?.language ?? null;
}

/**
 * Each line of `text` (the whole file at one revision) by a lexer pass in the language of `path`, in line order; null when
 * the language has no lexer or the lexer cannot be certain of the file.
 */
export function lineKinds(path: string, text: string): readonly LineKind[] | null {
  const ext = extensionOf(path);
  const lexer = ext === null ? null : LANGUAGES[ext]?.lexer ?? null;
  if (lexer === null) return null;
  const inCode = lexer.lex(text);
  if (inCode === null) return null;
  const lines = text.split('\n');
  if (inCode.length !== lines.length) throw new Error(`lexing ${path}: ${inCode.length} line starts for ${lines.length} lines`);
  const kinds = lines.map((line, i): LineKind => {
    if (!inCode[i]) return 'other';
    const t = line.trim();
    return t === '' ? 'blank' : t.startsWith(lexer.prefix) ? 'comment' : 'other';
  });
  return ext === 'go' ? withoutGoOutput(lines, kinds) : kinds;
}

/**
 * A Go example's `// Output:` (or `// Unordered output:`) comment and every comment or blank line after it up to the next
 * code line: what `go test` compares the example's output with, and whether that comment is the function's last comment
 * group (a blank line splits a group). Read as `other`, never as comments or blank lines.
 */
function withoutGoOutput(lines: readonly string[], kinds: readonly LineKind[]): readonly LineKind[] {
  let output = false;
  return kinds.map((k, i) => {
    if (k === 'other') {
      output = false;
      return k;
    }
    if (k === 'comment' && /^\/\/\s*(unordered output|output):/i.test(lines[i]!.trim())) output = true;
    return output ? 'other' : k;
  });
}

// ---------------------------------------------------------------------------------------------------
// The lexers: each returns, per line, whether the line starts in plain code (not inside a string or a block comment).

/**
 * JavaScript and TypeScript: line and block comments, quoted strings (an escaped newline continues one), template literals
 * with nested `${}` expressions. A slash that is neither comment opener may be division or a regular expression literal
 * (which never spans lines): the rest of its line is skipped, unless it holds a quote, a backtick or a block comment opener
 * (or, inside a template expression, a brace), where the two readings may part: unknown. HTML-like comments: unknown.
 * `jsx`: a JavaScript file may hold JSX, whose text may start with `//`: a `<` in code makes it unknown.
 */
function lexJs(text: string, jsx: boolean): readonly boolean[] | null {
  const starts: boolean[] = [true];
  // The brace depth of each open template expression, innermost last.
  const exprs: number[] = [];
  let mode: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === '\n') {
      if (mode === 'sq' || mode === 'dq') return null;
      if (mode === 'line') mode = 'code';
      starts.push(mode === 'code');
      continue;
    }
    switch (mode) {
      case 'line':
        break;
      case 'block':
        if (c === '*' && d === '/') {
          mode = 'code';
          i++;
        }
        break;
      case 'sq':
      case 'dq':
      case 'tpl':
        if (c === '\\') {
          if (d === '\n') starts.push(false);
          i++;
        } else if (mode === 'tpl' && c === '$' && d === '{') {
          exprs.push(0);
          mode = 'code';
          i++;
        } else if (c === { sq: "'", dq: '"', tpl: '`' }[mode]) mode = 'code';
        break;
      case 'code':
        if (c === '/' && d === '/') {
          mode = 'line';
          i++;
        } else if (c === '/' && d === '*') {
          mode = 'block';
          i++;
        } else if (c === '/') {
          const eol = text.indexOf('\n', i);
          const rest = text.slice(i + 1, eol === -1 ? text.length : eol);
          if (/['"`]|\/\*/.test(rest) || (exprs.length > 0 && /[{}]/.test(rest))) return null;
          i = (eol === -1 ? text.length : eol) - 1;
        } else if (c === "'") mode = 'sq';
        else if (c === '"') mode = 'dq';
        else if (c === '`') mode = 'tpl';
        else if (c === '<' && (jsx || text.startsWith('<!--', i))) return null;
        else if (c === '-' && text.startsWith('-->', i) && text.slice(text.lastIndexOf('\n', i - 1) + 1, i).trim() === '') return null;
        else if (c === '{' && exprs.length > 0) exprs[exprs.length - 1]!++;
        else if (c === '}' && exprs.length > 0) {
          if (exprs.at(-1) === 0) {
            exprs.pop();
            mode = 'tpl';
          } else exprs[exprs.length - 1]!--;
        }
        break;
    }
  }
  return mode === 'code' || mode === 'line' ? (exprs.length === 0 ? starts : null) : null;
}

/**
 * Go: line and block comments, interpreted strings and runes (single-line), raw strings (backticks, spanning lines). A file
 * importing "C" carries cgo's C preamble in its comments: unknown.
 */
function lexGo(text: string): readonly boolean[] | null {
  if (text.includes('"C"')) return null;
  const starts: boolean[] = [true];
  let mode: 'code' | 'line' | 'block' | 'str' | 'rune' | 'raw' = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === '\n') {
      if (mode === 'str' || mode === 'rune') return null;
      if (mode === 'line') mode = 'code';
      starts.push(mode === 'code');
      continue;
    }
    switch (mode) {
      case 'line':
        break;
      case 'block':
        if (c === '*' && d === '/') {
          mode = 'code';
          i++;
        }
        break;
      case 'str':
      case 'rune':
        if (c === '\\' && d === '\n') return null;
        if (c === '\\') i++;
        else if (c === (mode === 'str' ? '"' : "'")) mode = 'code';
        break;
      case 'raw':
        if (c === '`') mode = 'code';
        break;
      case 'code':
        if (c === '/' && d === '/') {
          mode = 'line';
          i++;
        } else if (c === '/' && d === '*') {
          mode = 'block';
          i++;
        } else if (c === '"') mode = 'str';
        else if (c === "'") mode = 'rune';
        else if (c === '`') mode = 'raw';
        break;
    }
  }
  return mode === 'code' || mode === 'line' ? starts : null;
}

/**
 * Python: `#` comments, strings with any prefix, single- or triple-quoted (a triple-quoted one, or an escaped newline,
 * spans lines). An f- or t-string's replacement field holding a quote or a `#` (which Python 3.12 allows to nest): unknown.
 */
function lexPython(text: string): readonly boolean[] | null {
  const starts: boolean[] = [true];
  type Str = { quote: string; triple: boolean; formatted: boolean; field: number };
  let mode: 'code' | 'line' | Str = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === '\n') {
      if (typeof mode === 'object' && !mode.triple) return null;
      if (mode === 'line') mode = 'code';
      starts.push(mode === 'code');
      continue;
    }
    if (mode === 'line') continue;
    if (mode === 'code') {
      if (c === '#') mode = 'line';
      else if (c === '"' || c === "'") {
        const prefix = /[A-Za-z]{0,2}$/.exec(text.slice(Math.max(0, i - 3), i))![0];
        const before = text[i - prefix.length - 1];
        const own = before === undefined || !/[\w]/.test(before) ? prefix : '';
        const triple = text.startsWith(c.repeat(3), i);
        mode = { quote: c, triple, formatted: /[ft]/i.test(own), field: 0 };
        if (triple) i += 2;
      }
      continue;
    }
    if (mode.field > 0) {
      if (c === '"' || c === "'" || c === '#') return null;
      if (c === '{') mode.field++;
      else if (c === '}') mode.field--;
      continue;
    }
    if (c === '\\') {
      if (d === '\n') starts.push(false);
      i++;
    } else if (mode.formatted && c === '{') {
      if (d === '{') i++;
      else mode.field = 1;
    } else if (mode.triple ? text.startsWith(mode.quote.repeat(3), i) : c === mode.quote) {
      if (mode.triple) i += 2;
      mode = 'code';
    }
  }
  return mode === 'code' || mode === 'line' ? starts : null;
}
