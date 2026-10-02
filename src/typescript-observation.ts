import path from 'node:path';
import { z } from 'zod';
import type { Scenario } from './config.js';
import { packageForModule, type DependencyInventory, type PackageInstance } from './dependency-inventory.js';
import { within, hash, type Roots } from './filesystem.js';
import type { ProcessResult } from './process.js';

export const TYPESCRIPT_OBSERVER_VERSION = 'typescript-explain-files-v1';
export const TYPESCRIPT_LIMITS = { max_bytes: 2_000_000, max_files: 4096, max_reasons_per_file: 64, max_line_chars: 4096 };
const text = z.string().max(4096);
export const compilationSchema = z.object({
  source: z.literal('typescript_explain_files'), collector_version: text,
  capture_status: z.enum(['captured', 'incomplete', 'unavailable']),
  compiler: z.object({ path: text, name: z.literal('typescript'), version: text }).optional(),
  executed_command: z.array(text).max(1024), raw_output_hash: text, raw_output_bytes: z.number().int().nonnegative(),
  limits: z.object({ max_bytes: z.number().int().positive(), max_files: z.number().int().positive(), max_reasons_per_file: z.number().int().positive(), max_line_chars: z.number().int().positive() }),
  files: z.array(z.object({ path: text, kind: z.enum(['declaration', 'source']), package: text.optional(), reasons: z.array(text).min(1).max(64) })).max(4096),
  packages: z.array(z.object({ path: text, name: text, version: text, files: z.array(text).max(4096) })).max(2048),
  issues: z.array(text).max(128), limitations: z.array(text).max(32),
});
export type CompilationObservation = z.infer<typeof compilationSchema>;
export const TYPESCRIPT_SCOPE = [
  'Files reported as part of this compilation, not all filesystem reads, executed modules, emitted code or necessary permissions.',
  'Module loads and compiler inputs are independent facts; the same package may occur in both. Unlisted packages are not proved unused.',
  'English explainFiles text is parsed within bounds. Unrecognized output, incomplete execution or missing records cannot establish an empty input set.',
  'Direct project-local node <typescript>/bin/tsc only; nested npm scripts, build mode, watch mode and response files are not collected.',
];

/** Appended only for observe; locale and pretty affect diagnostics, not emit. */
export function compilationCommand(scenario: Scenario): string[] {
  return scenario.observation?.typescript ? [...scenario.command, '--explainFiles', '--locale', 'en', '--pretty', 'false'] : scenario.command;
}

function location(file: string, roots: Roots): string {
  const absolute = path.resolve(roots.workspace, file);
  for (const [name, root] of Object.entries(roots)) if (within(root, absolute)) return `@${name}` + (absolute === root ? '' : '/' + path.relative(root, absolute).split(path.sep).join('/'));
  return '@external/' + path.basename(absolute);
}
function reason(text: string, roots: Roots): string {
  return text.replace(/from file '([^']+)'/g, (_, file: string) => `from file '${location(file, roots)}'`)
    .replace(/because '([^']*package\.json)'/g, (_, file: string) => `because '${location(file, roots)}'`)
    .replace(/in '([^']+\.json)'/g, (_, file: string) => `in '${location(file, roots)}'`);
}
const fileLine = /\.(?:[cm]?tsx?|[cm]?jsx?|json)$/i;
const knownReason = /^(?:Imported via |Library referenced via |Type library referenced via |Referenced via |Entry point (?:for|of) |Matched by (?:include|files) pattern |Part of 'files' list |Root file specified |File is (?:CommonJS|ECMAScript) module |Default library for |Source from referenced project |Output from referenced project )/;

export function collectCompilation(scenario: Scenario, inventory: DependencyInventory, roots: Roots, process?: ProcessResult): CompilationObservation | undefined {
  if (!scenario.observation?.typescript) return undefined;
  const compilerPath = scenario.observation.typescript.compiler;
  const installed = inventory.packages.find(p => p.path === compilerPath && p.name === 'typescript');
  const issues: string[] = [];
  const issue = (s: string) => { if (issues.length < 128) issues.push(s); };
  if (!installed) issue('Configured compiler is not an identified installed TypeScript package');
  if (!inventory.complete) issue('Package inventory is partial; compiler-input attribution may be incomplete');
  if (!process || process.status !== 'completed' || process.exit_code !== 0) issue('Compiler execution did not complete successfully; inputs are partial observations');
  const stdout = process?.stdout ?? '', bytes = Buffer.byteLength(stdout);
  if (bytes > TYPESCRIPT_LIMITS.max_bytes) issue('Compiler-output byte limit reached; retaining the bounded prefix');
  if (stdout && !stdout.endsWith('\n')) issue('Compiler output ended inside a line; retaining complete lines only');
  const bounded = Buffer.from(stdout).subarray(0, TYPESCRIPT_LIMITS.max_bytes).toString('utf8');
  const lines = bounded.split(/\r?\n/); if (!bounded.endsWith('\n')) lines.pop();
  const rows = new Map<string, CompilationObservation['files'][number]>();
  let current: string | undefined, reasons: string[] = [];
  const finish = () => {
    if (current) {
      if (!reasons.length) issue('A compiler input has no recognized explanation');
      else {
        const alias = location(current, roots), pkg = packageForModule(alias, inventory.packages);
        if (alias.length > 4096 || reasons.some(s => s.length > 4096)) { issue('Normalized compiler input/explanation exceeds its text limit'); current = undefined; reasons = []; return; }
        if (!alias.startsWith('@workspace/')) issue('Compiler input is outside the project; attribution is partial');
        if (alias.includes('/node_modules/') && !pkg) issue('Compiler input is outside the identified package inventory');
        const old = rows.get(alias);
        const combined = [...new Set([...(old?.reasons ?? []), ...reasons])];
        if (combined.length > TYPESCRIPT_LIMITS.max_reasons_per_file) issue('Per-file explanation limit reached');
        if (!old && rows.size >= TYPESCRIPT_LIMITS.max_files) issue('Compiler-input file limit reached');
        else rows.set(alias, { path: alias, kind: /\.d\.[cm]?ts$/i.test(current) ? 'declaration' : 'source',
          ...pkg ? { package: pkg.path } : {}, reasons: combined.slice(0, TYPESCRIPT_LIMITS.max_reasons_per_file) });
      }
    }
    current = undefined; reasons = [];
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.length > TYPESCRIPT_LIMITS.max_line_chars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(line)) { issue('Unsupported or oversized compiler-output line'); finish(); continue; }
    const explanation = line.match(/^ {2,3}(\S.*)$/);
    if (explanation) {
      const value = explanation[1];
      if (!current || !knownReason.test(value)) { issue('Unrecognized compiler explanation; parser coverage is partial'); continue; }
      if (reasons.length >= TYPESCRIPT_LIMITS.max_reasons_per_file) issue('Per-file explanation limit reached');
      else reasons.push(reason(value, roots));
    } else {
      finish();
      if (!/^\s/.test(line) && fileLine.test(line)) current = line;
      else issue('Unrecognized compiler output; parser coverage is partial');
    }
  }
  finish();
  const files = [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) issue('No explained compilation inputs were received; this is not an empty-input conclusion');
  const packages = new Map<string, PackageInstance & { files: string[] }>();
  for (const file of files) if (file.package) {
    const pkg = inventory.packages.find(p => p.path === file.package)!;
    const row = packages.get(pkg.path) ?? { ...pkg, files: [] }; row.files.push(file.path); packages.set(pkg.path, row);
  }
  return { source: 'typescript_explain_files', collector_version: TYPESCRIPT_OBSERVER_VERSION,
    capture_status: !files.length ? 'unavailable' : issues.length ? 'incomplete' : 'captured',
    ...installed ? { compiler: { path: installed.path, name: 'typescript', version: installed.version } } : {},
    executed_command: compilationCommand(scenario), raw_output_hash: hash(stdout), raw_output_bytes: bytes,
    limits: { ...TYPESCRIPT_LIMITS },
    files, packages: [...packages.values()].map(p => ({ path: p.path, name: p.name, version: p.version, files: p.files })).sort((a, b) => a.path.localeCompare(b.path)),
    issues, limitations: TYPESCRIPT_SCOPE };
}
