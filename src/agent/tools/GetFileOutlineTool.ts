import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition, ToolResult } from '../ToolRegistry';

interface OutlineSymbol {
  name: string;
  type: 'class' | 'function' | 'method' | 'interface' | 'type';
  line: number;
  indent: number;
}

export const GetFileOutlineTool: ToolDefinition = {
  name: 'get_file_outline',
  description:
    'Returns the structure of a file (classes, methods, functions with line numbers) WITHOUT reading the full content. ' +
    'Use this INSTEAD of read_file when you need to locate where a class or method is defined. ' +
    'Much faster than reading the whole file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (relative to workspace root or absolute)',
      },
    },
    required: ['path'],
  },

  async execute(args, workspaceRoot): Promise<ToolResult> {
    const relPath = args['path'] as string;
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath);

    let src: string;
    try {
      src = fs.readFileSync(absPath, 'utf8');
    } catch {
      return { success: false, output: `File not found: ${relPath}` };
    }

    const lines = src.split('\n');
    const totalLines = lines.length;
    const ext = path.extname(absPath).toLowerCase();

    let symbols: OutlineSymbol[];
    if (ext === '.py') {
      symbols = extractPythonOutline(lines);
    } else if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      symbols = extractTsOutline(lines);
    } else if (ext === '.go') {
      symbols = extractGoOutline(lines);
    } else if (['.java', '.kt', '.kts'].includes(ext)) {
      symbols = extractJavaLikeOutline(lines);
    } else if (['.cs'].includes(ext)) {
      symbols = extractCsOutline(lines);
    } else if (['.cpp', '.cc', '.cxx', '.c', '.h', '.hpp'].includes(ext)) {
      symbols = extractCppOutline(lines);
    } else if (ext === '.rb') {
      symbols = extractRubyOutline(lines);
    } else {
      return {
        success: true,
        output: `${relPath} (${totalLines} lines)\n[Outline not supported for ${ext} files — use grep_search to find symbols]`,
      };
    }

    if (symbols.length === 0) {
      return {
        success: true,
        output: `${relPath} (${totalLines} lines)\n[No symbols found]`,
      };
    }

    const output = renderOutline(relPath, totalLines, symbols);
    return { success: true, output };
  },
};

function renderOutline(filePath: string, totalLines: number, symbols: OutlineSymbol[]): string {
  const lines: string[] = [`${filePath} (${totalLines} lines)`, ''];

  for (const sym of symbols) {
    const indent = '  '.repeat(Math.max(0, sym.indent));
    const typeTag = sym.type === 'class' || sym.type === 'interface'
      ? sym.type.toUpperCase()
      : sym.type === 'method' ? 'method' : 'fn';
    lines.push(`${indent}${typeTag} ${sym.name}  [line ${sym.line}]`);
  }

  return lines.join('\n');
}

// ── Python ────────────────────────────────────────────────────────────────────

function extractPythonOutline(lines: string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    const indent = raw.length - trimmed.length;

    let m: RegExpMatchArray | null;
    m = trimmed.match(/^class\s+(\w+)/);
    if (m) {
      symbols.push({ name: m[1], type: 'class', line: i + 1, indent: Math.floor(indent / 4) });
      continue;
    }
    m = trimmed.match(/^(?:async\s+)?def\s+(\w+)/);
    if (m) {
      const type: 'method' | 'function' = indent > 0 ? 'method' : 'function';
      symbols.push({ name: m[1], type, line: i + 1, indent: Math.floor(indent / 4) });
    }
  }
  return symbols;
}

// ── TypeScript / JavaScript ───────────────────────────────────────────────────

function extractTsOutline(lines: string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trimStart();
    const indent = raw.length - t.length;
    let m: RegExpMatchArray | null;

    m = t.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
    if (m) {
      symbols.push({ name: m[1], type: 'class', line: i + 1, indent: Math.floor(indent / 2) });
      continue;
    }
    m = t.match(/^(?:export\s+)?interface\s+(\w+)/);
    if (m) {
      symbols.push({ name: m[1], type: 'interface', line: i + 1, indent: Math.floor(indent / 2) });
      continue;
    }
    m = t.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    if (m) {
      symbols.push({ name: m[1], type: 'function', line: i + 1, indent: Math.floor(indent / 2) });
      continue;
    }
    // Class methods: indented identifier followed by ( or async
    m = t.match(/^(?:(?:public|private|protected|static|async|override|readonly)\s+)*(\w+)\s*(?:<[^>]*>)?\s*\(/);
    if (m && indent >= 2 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('if') && !t.startsWith('while') && !t.startsWith('for') && !t.startsWith('switch') && m[1] !== 'if' && m[1] !== 'while' && m[1] !== 'for' && m[1] !== 'switch' && m[1] !== 'return' && m[1] !== 'throw') {
      symbols.push({ name: m[1], type: 'method', line: i + 1, indent: Math.floor(indent / 2) });
      continue;
    }
    // Arrow function assigned to const
    m = t.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (m) {
      symbols.push({ name: m[1], type: 'function', line: i + 1, indent: Math.floor(indent / 2) });
    }
  }

  // Remove duplicate method names at same line
  const seen = new Set<string>();
  return symbols.filter(s => {
    const key = `${s.line}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Go ────────────────────────────────────────────────────────────────────────

function extractGoOutline(lines: string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^type\s+(\w+)\s+struct/);
    if (m) { symbols.push({ name: m[1], type: 'class', line: i + 1, indent: 0 }); continue; }
    m = t.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/);
    if (m) { symbols.push({ name: m[1], type: 'function', line: i + 1, indent: 0 }); }
  }
  return symbols;
}

// ── Java / Kotlin ─────────────────────────────────────────────────────────────

function extractJavaLikeOutline(lines: string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trimStart();
    const indent = raw.length - t.length;
    let m: RegExpMatchArray | null;
    m = t.match(/(?:public|private|protected|internal|abstract|open|data|sealed)?\s*(?:class|interface|object|enum)\s+(\w+)/);
    if (m) { symbols.push({ name: m[1], type: 'class', line: i + 1, indent: Math.floor(indent / 4) }); continue; }
    m = t.match(/(?:public|private|protected|static|final|override|suspend)?\s*(?:fun|void|int|String|boolean|long|double|Object|List|Map)\s+(\w+)\s*\(/);
    if (m) { symbols.push({ name: m[1], type: 'method', line: i + 1, indent: Math.floor(indent / 4) }); }
  }
  return symbols;
}

// ── C# ───────────────────────────────────────────────────────────────────────

function extractCsOutline(lines: string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trimStart();
    const indent = raw.length - t.length;
    let m: RegExpMatchArray | null;
    m = t.match(/(?:public|private|protected|internal|static|abstract|sealed)?\s*(?:class|interface|struct|enum|record)\s+(\w+)/);
    if (m) { symbols.push({ name: m[1], type: 'class', line: i + 1, indent: Math.floor(indent / 4) }); continue; }
    m = t.match(/(?:public|private|protected|internal|static|virtual|override|async)?\s*\w[\w<>[\]]*\s+(\w+)\s*\(/);
    if (m && m[1] !== 'if' && m[1] !== 'while' && m[1] !== 'for' && m[1] !== 'switch') {
      symbols.push({ name: m[1], type: 'method', line: i + 1, indent: Math.floor(indent / 4) });
    }
  }
  return symbols;
}

// ── C / C++ ───────────────────────────────────────────────────────────────────

function extractCppOutline(lines: string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    let m: RegExpMatchArray | null;
    m = t.match(/^(?:class|struct)\s+(\w+)/);
    if (m) { symbols.push({ name: m[1], type: 'class', line: i + 1, indent: 0 }); continue; }
    m = t.match(/^(?:\w+\s+)+(\w+)\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/);
    if (m && !t.startsWith('//') && m[1] !== 'if' && m[1] !== 'while' && m[1] !== 'for') {
      symbols.push({ name: m[1], type: 'function', line: i + 1, indent: 0 });
    }
  }
  return symbols;
}

// ── Ruby ─────────────────────────────────────────────────────────────────────

function extractRubyOutline(lines: string[]): OutlineSymbol[] {
  const symbols: OutlineSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trimStart();
    const indent = raw.length - t.length;
    let m: RegExpMatchArray | null;
    m = t.match(/^class\s+(\w+)/);
    if (m) { symbols.push({ name: m[1], type: 'class', line: i + 1, indent: Math.floor(indent / 2) }); continue; }
    m = t.match(/^def\s+(\w+)/);
    if (m) { symbols.push({ name: m[1], type: indent > 0 ? 'method' : 'function', line: i + 1, indent: Math.floor(indent / 2) }); }
  }
  return symbols;
}
