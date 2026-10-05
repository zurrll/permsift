import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { configSchema, limitsSchema, readConfigurationDocument, validatePolicy, installationScenario, isStaged, initialPreparation,
  type Config, type Limits, type Scenario, type Assertion } from './config.js';
import { compilationCommand } from './typescript-observation.js';

export const explanationModes = ['run', 'tighten', 'observe', 'check'] as const;
export type ExplanationMode = typeof explanationModes[number];
type Issue = { file: string; path: string; message: string };
type Default = { file: string; path: string; value: unknown };
type Origin = { file: string; path: string; kind: 'declared' | 'default' | 'inherited' };
type Grant = { grants: string[]; origin: Origin };
type TaskPreview = {
  id: string; config_path: string; command: string[]; executed_command: string[]; timeout_seconds: number;
  policy_role: 'initial' | 'control_and_repair_input';
  task: { write: Grant; read: Grant & { mode: 'legacy' | 'explicit' }; network: string[]; protection_goals: Scenario['protection_goals'] };
  installation: null | { mode: 'separate' | 'shared'; manager: 'npm'; cache: 'cold' | 'warm'; cache_seed?: string;
    registry: string; scripts: 'disabled'; write: Grant; read: string[]; network: Grant; offline: boolean };
  initial_preparation: string[]; assertion_outputs_removed: string[]; observation_output_root_removed?: string;
  artifacts: { path: string; checks: { index: number; assertion: Assertion; meaning: string }[] }[];
  process_checks: { index: number; assertion: Assertion; meaning: string }[];
  search: { active: boolean; task_write_auto: boolean; task_write_candidates: Scenario['narrower_candidates'];
    task_read_active: boolean; task_read_auto: boolean; task_read_candidates: Scenario['narrower_read_candidates'];
    install_write_active: boolean; install_write_auto: boolean; install_write_candidates: Scenario['narrower_candidates']; network_active: boolean };
  observation: { active: boolean; modules: boolean; typescript: boolean; esbuild: boolean };
};
export type ConfigurationExplanation = {
  schema_version: 1; kind: 'configuration_explanation'; status: 'valid' | 'invalid'; scope: 'static_configuration_only'; for: ExplanationMode;
  files: { config: string; limits: string }; project?: { configured: string; resolved?: string }; exclude?: string[];
  normalized?: { config: Config; limits: Limits }; defaults_applied: Default[]; tasks: TaskPreview[]; issues: Issue[];
  schedule?: { nominal_task_executions: number | null; nominal_installations: number | null; repetitions: number;
    candidate_limit: number; budget_seconds: number; basis: string; additional_work: string[] };
  task_executions: 0; installations: 0; limitations: string[];
};

const own = (value: unknown, key: string | number): unknown => value !== null && typeof value === 'object' && Object.hasOwn(value, key)
  ? (value as Record<string, unknown>)[key] : undefined;
function defaults(normalized: unknown, raw: unknown, file: string, prefix = ''): Default[] {
  if (raw === undefined) return [{ file, path: prefix, value: normalized }];
  if (normalized === null || typeof normalized !== 'object') return [];
  return Object.entries(normalized).flatMap(([key, value]) => defaults(value, own(raw, key), file, prefix ? `${prefix}.${key}` : key));
}

function assertionMeaning(a: Assertion): string {
  switch (a.type) {
    case 'exit_code': return '仅检查任务正常完成且退出码为 0；依靠命令自身的检查，不独立验证产物或业务正确性。';
    case 'file_exists': return '检查普通文件存在且不超过 1 MiB；不检查内容是否正确，空文件也可通过。';
    case 'file_contains': return '检查文件包含指定文本；不检查其余内容或产物行为。';
    case 'json_equals': return '解析 JSON 后按指定指针比较值及类型；不检查其他字段。';
    case 'test_results': return '预期名称必须全部出现且名称不能重复；报告中所有测试都必须 passed，包括未列为预期的测试。报告真实性需另行判断。';
    case 'junit': return '预期 name 必须各出现一次；检查重复 classname/name、统计一致性；报告中所有测试都必须通过，包括非预期项。报告真实性需另行判断。';
  }
}

function preview(s: Scenario, index: number, file: string, mode: ExplanationMode): TaskPreview {
  const base = `scenarios.${index}`, search = mode === 'tighten', observe = mode === 'observe';
  const staged = isStaged(s), installer = installationScenario(s);
  const origin = (field: string, kind: Origin['kind'] = 'declared'): Origin => ({ file, path: `${base}.${field}`, kind });
  const artifacts: TaskPreview['artifacts'] = [];
  for (const [index, assertion] of s.assertions.entries()) {
    if (assertion.type === 'exit_code') continue;
    let artifact = artifacts.find(a => a.path === assertion.path);
    if (!artifact) { artifact = { path: assertion.path, checks: [] }; artifacts.push(artifact); }
    artifact.checks.push({ index, assertion, meaning: assertionMeaning(assertion) });
  }
  return {
    id: s.id, config_path: base, command: s.command, executed_command: observe ? compilationCommand(s) : s.command,
    timeout_seconds: s.timeout_seconds, policy_role: mode === 'check' ? 'control_and_repair_input' : 'initial',
    task: { write: { grants: s.initial_write_grants, origin: origin('initial_write_grants') },
      read: { mode: s.initial_read_grants === undefined ? 'legacy' : 'explicit', grants: s.initial_read_grants ?? ['@workspace'],
        origin: origin('initial_read_grants', s.initial_read_grants === undefined ? 'default' : 'declared') },
      network: [], protection_goals: s.protection_goals ?? [] },
    installation: s.install ? {
      mode: staged ? 'separate' : 'shared', manager: s.install.manager, cache: s.install.cache,
      ...s.install.cache_seed ? { cache_seed: s.install.cache_seed } : {}, registry: s.install.registry, scripts: 'disabled',
      write: { grants: installer.initial_write_grants, origin: origin(staged ? 'install.initial_write_grants' : 'initial_write_grants', staged ? 'declared' : 'inherited') },
      read: ['@workspace'], network: { grants: s.initial_network_grants ?? [], origin: origin('initial_network_grants', s.initial_network_grants === undefined ? 'default' : 'declared') },
      offline: s.install.cache === 'warm',
    } : null,
    initial_preparation: initialPreparation(s), assertion_outputs_removed: artifacts.map(a => a.path),
    ...observe && s.observation?.esbuild ? { observation_output_root_removed: s.observation.esbuild.output_root } : {},
    artifacts, process_checks: s.assertions.flatMap((assertion, index) => assertion.type === 'exit_code' ? [{ index, assertion, meaning: assertionMeaning(assertion) }] : []),
    search: { active: search, task_write_auto: search && s.auto_discover, task_write_candidates: s.narrower_candidates,
      task_read_active: search && s.initial_read_grants !== undefined, task_read_auto: search && s.initial_read_grants !== undefined && s.auto_read_discover,
      task_read_candidates: s.narrower_read_candidates, install_write_active: search && staged,
      install_write_auto: search && staged && installer.auto_discover, install_write_candidates: staged ? installer.narrower_candidates : [], network_active: search && !!s.install },
    observation: { active: observe, modules: observe, typescript: observe && !!s.observation?.typescript, esbuild: observe && !!s.observation?.esbuild },
  };
}

/** Reads configuration documents and resolves the project path only. No project scan or execution backend. */
export async function explainConfiguration(options: { configPath: string; limitsPath: string; forMode?: ExplanationMode }): Promise<ConfigurationExplanation> {
  const mode = options.forMode ?? 'run';
  if (!explanationModes.includes(mode)) throw new Error('Expected --for run, tighten, observe or check');
  const report: ConfigurationExplanation = { schema_version: 1, kind: 'configuration_explanation', status: 'invalid', scope: 'static_configuration_only', for: mode,
    files: { config: path.resolve(options.configPath), limits: path.resolve(options.limitsPath) }, defaults_applied: [], tasks: [], issues: [],
    task_executions: 0, installations: 0, limitations: [
      '静态检查通过只表示配置结构和声明关系通过检查；任务、边界和采集尚未验证。任务执行仍要求 macOS，环境检查使用 doctor。',
      '@workspace 表示隔离项目副本，@cache 和 @tmp 表示本轮私有目录；不是宿主项目、宿主缓存或系统临时目录的直接授权。',
      '这里列出初始可变授权和固定保护声明，不是后端最终展开的全部系统权限。目录授权覆盖子路径，文件读取按文件精确授权；目标类型须在执行时核对，固定保护禁止规则仍然生效。',
      '省略 initial_read_grants 时整个工作区可读；allowed_read_roots 不约束这种旧式读取，也不约束安装阶段的固定工作区读取。',
      '缓存与临时目录读取、工作区根目录访问和后端系统运行时读取固定保留；显式读取空数组不等于零读取权限。',
      '安装使用锁文件并禁用生命周期脚本；任务始终断网。暖缓存安装采用 --offline，声明网络权限不表示会发生网络请求。',
      '只读配置和 limits，解析 project 路径；未检查命令能否执行、锁文件支持性、缓存/读取/保护目标类型、输入大小、产物内容或输出目录位置。',
      '产物断言目标会从隔离副本删除并创建父目录；分阶段安装后再次删除。observe 的 esbuild output_root 整体清空。原项目不做这些清理。',
      '成功还要求进程通过、安装核对（如有）、边界探针及声明的保护目标通过；产物检查全部满足仍不能证明报告诚实或任务覆盖充分。',
      'observe 在任务中加入内置 Node 预加载和一个私有日志目录写例外；各观察来源独立，缺少加载记录不代表依赖无用。',
    ] };
  const documents = await Promise.allSettled([readConfigurationDocument(options.configPath), readConfigurationDocument(options.limitsPath)]);
  const parsed: { config?: Config; limits?: Limits } = {};
  for (const [index, result] of documents.entries()) {
    const key = index === 0 ? 'config' : 'limits';
    if (result.status === 'rejected') { report.issues.push({ file: report.files[key], path: '$', message: String(result.reason) }); continue; }
    report.files[key] = result.value.file;
    const validation = (key === 'config' ? configSchema : limitsSchema).safeParse(result.value.value);
    if (!validation.success) {
      report.issues.push(...validation.error.issues.map(i => ({ file: result.value.file, path: i.path.join('.') || '$', message: i.message })));
    } else {
      if (key === 'config') parsed.config = validation.data as Config; else parsed.limits = validation.data as Limits;
      report.defaults_applied.push(...defaults(validation.data, result.value.value, result.value.file));
    }
  }
  const { config, limits } = parsed;
  if (!config || !limits) return report;
  report.normalized = { config, limits }; report.exclude = config.exclude;
  report.project = { configured: config.project };
  try { report.project.resolved = await realpath(path.resolve(path.dirname(report.files.config), config.project)); }
  catch (e) { report.issues.push({ file: report.files.config, path: 'project', message: String(e) }); }
  const ids = new Set<string>();
  for (const [index, s] of config.scenarios.entries()) {
    if (ids.has(s.id)) report.issues.push({ file: report.files.config, path: `scenarios.${index}.id`, message: `Duplicate scenario id: ${s.id}` });
    ids.add(s.id);
    try { validatePolicy({ ...config, scenarios: [s] }, limits, mode === 'observe'); }
    catch (e) { report.issues.push({ file: report.files.config, path: `scenarios.${index}`, message: `${String(e)} (trusted limits: ${report.files.limits})` }); }
    report.tasks.push(preview(s, index, report.files.config, mode));
  }
  const factor = mode === 'observe' ? 1 : limits.repetitions * (mode === 'tighten' ? 2 : 1);
  report.schedule = { nominal_task_executions: mode === 'check' ? null : config.scenarios.length * factor,
    nominal_installations: mode === 'check' ? null : config.scenarios.filter(s => s.install).length * factor,
    repetitions: limits.repetitions, candidate_limit: mode === 'tighten' || mode === 'check' ? limits.max_candidates : 0, budget_seconds: limits.budget_seconds,
    basis: mode === 'check' ? '未读取历史基线，不能确定实际策略、任务或安装次数；显示的授权仅是当前配置的宽对照/修复输入。'
      : mode === 'tighten' ? '全部任务成功时，初始基线与最终验证的计划次数；不包含目录准备确认、候选、恢复或复查。'
      : mode === 'observe' ? '计划每任务一次；忽略 limits.repetitions，不搜索、不导出权限推荐。'
      : '全部任务成功时的初始策略重复验证；不搜索。',
    additional_work: ['失败、安装失败、中断或预算耗尽可能减少实际任务次数；安装后任务可能未执行。',
      '安装、前后边界探针、保护目标检查、快照/哈希和采集也有成本；上述任务次数不是全部沙箱调用数。',
      ...mode === 'tighten' ? ['max_candidates 只限制搜索候选，不限制基线、恢复、准备确认和最终验证；0 也会执行验证。',
        '分阶段任务候选可复用本轮安装快照；基线与最终验证重新安装，不跨 observe 任务共享安装。'] : []] };
  report.status = report.issues.length ? 'invalid' : 'valid';
  return report;
}

const json = (value: unknown) => JSON.stringify(value);
const list = (values: string[]) => values.length ? values.map(json).join(', ') : '[]';
export function configurationExplanationText(r: ConfigurationExplanation): string {
  const lines = [`Permsift 配置解释 · ${r.status === 'valid' ? '静态检查通过' : '配置无效'} · 用于 ${r.for}`, '',
    '任务执行 0 次；依赖安装 0 次。', `配置：${json(r.files.config)}`, `可信上限：${json(r.files.limits)}`,
    ...r.project ? [`项目：${json(r.project.resolved ?? r.project.configured)}`, `排除顶层目录：${list(r.exclude ?? [])}`] : [], ''];
  if (r.normalized) lines.push('可信上限（不是自动授权）', `  写：${list(r.normalized.limits.allowed_write_roots)}`,
    `  可变读取：${r.normalized.limits.allowed_read_roots === undefined ? '未声明' : list(r.normalized.limits.allowed_read_roots)}`,
    `  安装域名：${r.normalized.limits.allowed_network_domains === undefined ? '未声明' : list(r.normalized.limits.allowed_network_domains)}`, '');
  for (const t of r.tasks) {
    lines.push(`任务 ${json(t.id)} (${t.config_path})`, `  命令 argv：${json(t.executed_command)}`, `  超时：${t.timeout_seconds} 秒`,
      `  权限用途：${t.policy_role === 'initial' ? '初始方案' : '宽对照/修复输入；历史实际策略未读取'}`,
      `  请求写权限：${list(t.task.write.grants)} (${t.task.write.origin.path})`,
      `  请求工作区读取：${list(t.task.read.grants)} (${t.task.read.mode}; ${t.task.read.origin.kind}; ${t.task.read.origin.path})`,
      '  任务网络：断网');
    if (t.installation) lines.push(`  安装：npm ci，脚本禁用，${t.installation.mode === 'separate' ? '分阶段权限' : '共用任务写权限'}，${t.installation.cache} 缓存${t.installation.offline ? ' (--offline)' : ''}`,
      `    写：${list(t.installation.write.grants)} (${t.installation.write.origin.kind}; ${t.installation.write.origin.path})`,
      '    工作区读取：@workspace（固定；不使用任务读取规则或任务保护目标）',
      `    网络授权：${list(t.installation.network.grants)}`, `    注册表：${json(t.installation.registry)}`,
      ...t.installation.cache_seed ? [`    缓存种子：${json(t.installation.cache_seed)}`] : []);
    else lines.push('  安装：无；依赖需已在输入项目中准备');
    lines.push(`  初始预建目录：${list(t.initial_preparation)}`, `  副本中删除的断言产物：${list(t.assertion_outputs_removed)}`,
      ...t.observation_output_root_removed ? [`  副本中整体清空的产物目录：${json(t.observation_output_root_removed)}`] : [],
      `  权限搜索：${t.search.active ? `开启；任务写自动发现 ${t.search.task_write_auto}；任务读收缩 ${t.search.task_read_active}；安装写收缩 ${t.search.install_write_active}；安装网络撤销 ${t.search.network_active}` : '未开启；候选和自动发现设置不执行搜索'}`,
      `  观察：${t.observation.active ? `Node 模块；TypeScript ${t.observation.typescript}；esbuild ${t.observation.esbuild}` : '未开启；采集设置不执行采集'}`,
      ...t.task.protection_goals?.map(g => `  固定保护 ${json(g.key)}：禁止 ${g.operation} ${json(g.target)}（${g.target_kind}，任务阶段）`) ?? []);
    for (const check of t.process_checks) lines.push(`  进程检查 #${check.index} ${json(check.assertion)} — ${check.meaning}`);
    for (const a of t.artifacts) {
      lines.push(`  产物 ${json(a.path)}：全部检查须通过`);
      for (const check of a.checks) lines.push(`    #${check.index} ${check.assertion.type} ${json(check.assertion)} — ${check.meaning}`);
    }
    lines.push('');
  }
  if (r.schedule) lines.push('执行安排（条件成立时的计划，不是实测）',
    `  任务：${r.schedule.nominal_task_executions ?? '无法静态确定'}；安装：${r.schedule.nominal_installations ?? '无法静态确定'}；候选上限：${r.schedule.candidate_limit}；预算：${r.schedule.budget_seconds} 秒`,
    `  ${r.schedule.basis}`, ...r.schedule.additional_work.map(s => '  ' + s), '');
  if (r.defaults_applied.length) {
    lines.push('采用的 schema 默认值（省略字段）');
    for (const file of [...new Set(r.defaults_applied.map(d => d.file))]) {
      lines.push(`  ${json(file)}`, ...r.defaults_applied.filter(d => d.file === file).map(d => `    ${d.path} = ${json(d.value)}`));
    }
    lines.push('');
  }
  if (r.issues.length) lines.push('需要修正', ...r.issues.map(i => `  ${json(i.file)} · ${i.path}: ${i.message}`), '');
  lines.push('解释范围', ...r.limitations.map(s => '  ' + s));
  return lines.join('\n');
}
