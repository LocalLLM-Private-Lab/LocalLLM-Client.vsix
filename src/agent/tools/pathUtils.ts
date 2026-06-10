import * as path from 'path';

export type ResolvedPath =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Resolve a tool-supplied path (relative or absolute) and refuse anything that
 * lands outside the workspace. Write tools are auto-approved in edit/auto mode,
 * so without this check the agent could modify arbitrary files on disk.
 */
export function resolveWritePath(rawPath: string, workspaceRoot: string): ResolvedPath {
  const root = path.resolve(workspaceRoot);
  const abs = path.resolve(root, rawPath);
  const rel = path.relative(root, abs);

  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      ok: false,
      error:
        `Refusing to write outside the workspace: "${rawPath}". ` +
        `Only paths inside ${root} are allowed. Use a workspace-relative path like "src/file.ts".`,
    };
  }
  return { ok: true, path: abs };
}
