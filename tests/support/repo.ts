import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** The root of the repository: the nearest folder above the working directory with the workspace file. */
export function repoRoot(): string {
  let folder = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(folder, 'pnpm-workspace.yaml'))) return folder;
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  throw new Error('repoRoot: no pnpm-workspace.yaml above the working directory');
}

export interface SourceFile {
  /** Relative to the repository root, with forward slashes. */
  path: string;
  source: string;
}

/** Every file under a folder of the repository whose name ends with one of the extensions. */
export function readSources(
  folder: string,
  extensions: readonly string[],
  skip: (path: string) => boolean = () => false,
): SourceFile[] {
  const root = repoRoot();
  const start = join(root, folder);
  const files: SourceFile[] = [];
  if (!existsSync(start)) return files;
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!extensions.some((extension) => name.endsWith(extension))) continue;
      const path = relative(root, full).split(sep).join('/');
      if (skip(path)) continue;
      files.push({ path, source: readFileSync(full, 'utf8') });
    }
  };
  walk(start);
  return files;
}
