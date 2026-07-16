/**
 * Heuristic detection of shell commands that are destructive or hard to
 * reverse (recursive force delete, git force-push / hard-reset / force-clean).
 * This is a safety net for the run_terminal permission dialog, not a parser —
 * it segments a chained command (; && || |) and checks each part.
 */

function splitSegments(command: string): string[] {
  return command.split(/&&|\|\||[;|]/).map((s) => s.trim()).filter(Boolean);
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/** Bundled POSIX short options only (-rf, -fr, -r, -f). Deliberately excludes
 *  PowerShell's single-dash-long-name params ("-Force", "-Verbose"), which
 *  would otherwise false-positive on any flag whose name contains the letter. */
function hasPosixShortFlag(tokens: string[], letter: string): boolean {
  return tokens.some((t) => /^-[a-z]+$/i.test(t) && t.toLowerCase().includes(letter));
}

function hasNamedFlag(tokens: string[], names: string[]): boolean {
  return tokens.some((t) => names.includes(t.toLowerCase()));
}

const POSIX_DELETE_CMDS = new Set(['rm']);
const POWERSHELL_DELETE_CMDS = new Set(['remove-item', 'ri', 'rd', 'del', 'erase']);

/** Returns a short human-readable reason if the command looks destructive, else null. */
export function detectDestructiveCommand(command: string): string | null {
  for (const segment of splitSegments(command)) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    const head = tokens[0].toLowerCase();
    const args = tokens.slice(1);

    if (POSIX_DELETE_CMDS.has(head) && hasPosixShortFlag(args, 'r') && hasPosixShortFlag(args, 'f')) {
      return 'recursive force delete';
    }
    if (
      POWERSHELL_DELETE_CMDS.has(head) &&
      hasNamedFlag(args, ['-recurse', '--recursive']) &&
      hasNamedFlag(args, ['-force'])
    ) {
      return 'recursive force delete';
    }

    if (head === 'git') {
      const sub = args[0]?.toLowerCase();
      const rest = args.slice(1);
      if (sub === 'push' && (hasNamedFlag(rest, ['--force', '--force-with-lease']) || hasPosixShortFlag(rest, 'f'))) {
        return 'git force push';
      }
      if (sub === 'reset' && hasNamedFlag(rest, ['--hard'])) {
        return 'git hard reset';
      }
      if (sub === 'clean' && hasPosixShortFlag(rest, 'f')) {
        return 'git force clean';
      }
      if (sub === 'branch' && rest.includes('-D')) {
        return 'git force branch delete';
      }
    }
  }
  return null;
}
