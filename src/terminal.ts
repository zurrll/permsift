import path from 'node:path';
import type { ResultRecord, ExecutionView, SavedComparison } from './result-reader.js';
import type { ResultSummary, Claim, TaskSummary } from './result-explanation.js';
import type { Saved, PolicyPlan } from './model/types.js';
import type { ConfigurationExplanation } from './configuration-explanation.js';
import { packageContextLines, type PackageInspection } from './usage-inspection.js';
import type { SuccessDiagnostic } from './success-diagnostics.js';

/** Presentation only. Never used to evaluate, adopt or validate a policy. */
export type TerminalView = { schema_version: 1; kind: 'permsift_terminal_view'; title: string; lines: string[];
  notices: string[]; footer: string[]; details: string[]; result: string };
export const cleanText = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
const saved = <T>(v?: Saved<T>): T | undefined => v?.state === 'recorded' ? v.value : undefined;
const unique = (s: string[]) => [...new Set(s)];
const names = (s: string[]) => s.length ? s.slice(0, 6).join('、') + (s.length > 6 ? ` 等 ${s.length} 项（完整列表见 --details）` : '') : '无';
const stateNames: Record<string, string> = { pass: '通过', fail: '失败', unknown: '无法确定', not_run: '未执行', not_saved: '未保存',
  reported_only: '仅有报告声明', contradictory: '结论冲突', captured: '采集完成', incomplete: '采集不完整', unavailable: '不可用',
  not_collected: '未采集', compatible: '旧规则通过', permission_change: '权限需求变化', unresolved_failure: '任务仍失败，原因未确定',
  inconclusive: '无法确定', pending: '未完成', new_task_verified: '新增任务通过', removed_task: '任务已移除',
  exhausted: '当前候选已测试完', fixed_point: '本轮规则不再变化', budget: '预算耗尽', unstable: '恢复验证不稳定',
  candidate_limit: '候选上限', max_candidates: '候选上限', running: '进行中', diagnosed: '已诊断', partial: '部分结果',
  completed: '已结束', timed_out: '超时', aborted: '已中断', output_limit: '输出超限', error: '出错' };
const state = (s?: string) => stateNames[s ?? 'not_saved'] ?? s ?? '未保存';
export function displayPath(file: string, cwd = process.cwd()): string {
  const relative = path.relative(cwd, file);
  return cleanText(relative && !relative.startsWith('..' + path.sep) && relative !== '..' ? relative : file);
}
const dimension = (s: string) => ({ task: '任务', boundaries: '固定边界检查', protections: '保护目标', policy: '权限', terms: '任务约定',
  cost: '成本', agreement: '保护声明', workflow: '工作流', comparison: '复验', suggestion: '修复建议', inventory: '安装清单',
  modules: 'Node 加载记录', resolutions: '解析明细', compiler: 'TypeScript 输入', build: '产物输入', search: '搜索', verification: '验证依据' }[s] ?? s);
const get = (t: TaskSummary, d: string) => t.claims.find(c => c.dimension === d);
function detailLines(summary: ResultSummary): string[] {
  const show = (c: Claim) => [`${dimension(c.dimension)} · ${state(c.status)}：${c.statement}`,
    ...c.evidence.map(e => `  依据：${e.file} ${e.pointer}${e.availability ? '（未提供）' : ''}`), `  建议：${c.action.text}`];
  return ['详细依据（原始检查说明保留原文）', ...summary.claims.flatMap(show), ...summary.tasks.flatMap(t => [
    '', `任务 ${t.task}`, ...t.claims.flatMap(show), ...t.stages.map(s => `  阶段 ${s.phase}：任务 ${state(s.task)}；边界 ${state(s.boundaries)}；保护 ${s.protections ? state(s.protections) : '未声明'}；材料 ${s.retained ? '已保留' : '未提供'}`),
    ...t.decisions.flatMap(d => [`  候选：${saved(d.operation) ?? '操作未保存'}；决定 ${d.reported_decision}；依据 ${d.support}`,
      `    前：${(saved(d.before) ?? ['未保存']).join('、') || '无'}；后：${(saved(d.after) ?? ['未保存']).join('、') || '无'}`,
      `    候选 ${d.candidate}；恢复 ${d.recovery}；范围变化 ${d.scope_change}`,
      ...d.evidence.map(e => `    依据：${e.file} ${e.pointer}`)])]),
    ...summary.analysis.gaps.map(g => '材料缺口：' + g), ...summary.limitations.map(s => '范围：' + s)];
}
function policyLines(p: PolicyPlan): string[] {
  const read = saved(p.task.read), write = saved(p.task.write), network = saved(p.task.network), install = saved(p.installation);
  const aliases = (s: string[]) => names(s.map(p => p === '@workspace' ? '项目副本整体' : p === '@cache' ? '本轮缓存' : p === '@tmp' ? '本轮临时目录' : p));
  return [`写入：${write ? aliases(write) : '未保存'}；读取：${read ? read.mode === 'legacy' ? '项目副本整体（默认）' : read.grants.length ? aliases(read.grants) : '未授权项目文件读取（固定运行时读取保留）' : '未保存'}；任务网络：${network ? network.length ? names(network) : '断网' : '未保存'}`,
    ...install ? [`安装权限：写 ${aliases(install.write)}；域名 ${names(saved(install.network) ?? ['未保存'])}`] : []];
}
function selected(record: ResultRecord, task: string): ExecutionView[] {
  if (record.adoption) return record.adoption.tasks.find(t => t.key === task)?.proofs ?? [];
  const source = record.executionReport ?? record;
  const all = source.executions.filter(e => e.task === task);
  if (source.model?.workflow.kind === 'tighten') {
    const final = all.filter(e => e.facts.origin.phase === 'final');
    return final.length ? final : all.filter(e => ['baseline', 'discovery_baseline'].includes(e.facts.origin.phase));
  }
  return all;
}
function executionProblems(values: ExecutionView[]): string[] {
  return unique(values.flatMap(v => {
    const f = v.facts, process = saved(f.process), install = saved(f.installation);
    return [...process && (process.status !== 'completed' || process.exit_code !== 0) ? [`${v.task}：任务进程${state(process.status)}，退出码 ${process.exit_code ?? '未提供'}`] : [],
      ...install && install.reported_verdict !== 'pass' ? [`${v.task}：依赖安装${state(install.reported_verdict)}；任务 ${state(f.outcomes.task.status)}`] : [],
      ...(saved(f.assertions) ?? []).filter(c => c.status !== 'pass').map(c => `${v.task}：${c.name} ${state(c.status)}；${c.detail}`),
      ...(saved(f.boundaries) ?? []).flatMap(s => s.checks.filter(c => c.status !== 'pass').map(c => `${v.task}：边界检查 ${c.name} ${state(c.status)}；${c.detail}`)),
      ...f.outcomes.protections && f.outcomes.protections.status !== 'pass' ? [`${v.task}：保护目标${state(f.outcomes.protections.status)}`] : []];
  }));
}
function compareLines(c: SavedComparison): string[] {
  return [`项目输入${c.conditions.input_changed ? '已变化' : '未变化'}；配置${c.conditions.config_changed ? '已变化' : '未变化'}；可信上限${c.conditions.limits_changed ? '已变化' : '未变化'}`,
    ...c.conditions.environment_changed.length ? [`环境变化：${names(c.conditions.environment_changed)}`] : [],
    ...c.conditions.observer_changed ? ['观察器已变化，比较时需考虑采集条件差异。'] : [],
    ...c.tasks.flatMap(t => {
      const show = (label: string, s: { state: string; added: {name:string}[]; removed: {name:string}[]; version_changes: {name:string;before:string;after:string}[] }) => [
        `  ${label}：${s.state === 'compared' ? `新增 ${s.added.length}、不再记录 ${s.removed.length}、版本变化 ${s.version_changes.length}` : '无法完整比较'}`,
        ...s.version_changes.map(p => `    ${p.name}：${p.before} → ${p.after}`),
        ...s.added.map(p => `    新增记录：${p.name}`), ...s.removed.map(p => `    不再记录：${p.name}`)];
      return [`${t.task}：${t.state === 'added_task' ? '新增任务' : t.state === 'removed_task' ? '移除任务' : t.state === 'unavailable' ? '无法比较' : '记录对比'}`,
        ...show('Node 加载', t), ...t.compilation ? show('TypeScript 输入', t.compilation) : [], ...t.bundling ? show('产物输入', t.bundling) : [],
        ...t.bundling?.added_inputs.map(p => `    新增输入：${p}`) ?? [], ...t.bundling?.removed_inputs.map(p => `    不再记录输入：${p}`) ?? [],
        ...t.bundling ? [`    产物记录变化：${t.bundling.changed_outputs.length}；贡献变化：${t.bundling.contribution_changes.length}；引入链变化：${t.bundling.chain_changes.length}；外部引用变化：${t.bundling.external_changes.length}`] : [],
        ...t.compilation ? [`    文件新增 ${t.compilation.added_files.length}、不再记录 ${t.compilation.removed_files.length}、原因变化 ${t.compilation.explanation_changes.length}`] : []];
    })];
}

/** Use validated facts/statuses, never parse English claim prose to infer results. */
export function terminalView(record: ResultRecord, summary: ResultSummary): TerminalView {
  const kind = summary.workflow?.kind ?? 'execution', status = summary.workflow?.reported_status ?? 'not_saved';
  const titles: Record<string, string> = { 'doctor:verified': '环境检查通过 · 内置任务与固定边界探针通过',
    'run:verified': '验证通过 · 当前规则可以完成这些任务', 'tighten:verified': '收缩结果已验证',
    'check:compatible': '复验通过 · 旧权限仍然适用', 'check:review_required': '需要审阅 · 任务约定已变化',
    'check:regressed': '复验未通过 · 查看任务与权限变化', 'observe:observed': '观察完成 · 任务通过', 'observe:verified': '观察任务执行通过',
    'adopt:adopted': '已采用基线 · 已保存规则与历史证据', 'compare:compared': '比较完成 · 已列出记录变化' };
  const fallback = kind === 'execution' ? '单次执行记录' : `${({run:'验证',tighten:'收缩',doctor:'环境检查',check:'复验',observe:'观察',compare:'比较'} as Record<string,string>)[kind] ?? '执行'}${({failed:'失败',incomplete:'未完成',inconclusive:'无法确定',running:'进行中',partial:'不完整'} as Record<string,string>)[status] ?? '状态未保存'}`;
  const view: TerminalView = { schema_version: 1, kind: 'permsift_terminal_view', title: titles[`${kind}:${status}`] ?? fallback,
    lines: [], notices: [], footer: [], details: detailLines(summary), result: record.file };
  const lines = view.lines, notices = view.notices, footer = view.footer, claims = [...summary.claims, ...summary.tasks.flatMap(t => t.claims)];
  if (claims.some(c => c.status === 'contradictory')) { view.title = '结论存在冲突 · 不能确认通过'; notices.push('报告声明与保存的检查事实不一致，需先核对详细依据。'); }
  else if (summary.analysis.status === 'partial') {
    view.title = kind === 'observe' && summary.tasks.length && summary.tasks.every(t => get(t, 'task')?.status === 'pass') ? '任务通过 · 观察或验证依据不完整' : `依据不完整 · 报告记录：${summary.workflow?.reported_status ?? '单次执行'}`;
    notices.push('保存材料或采集记录存在缺口，不能把报告声明当作完整验证。');
  }
  if (record.context?.error) notices.push('原因：' + record.context.error);
  if (record.context?.project) (kind === 'doctor' ? view.details : lines).push('项目：' + displayPath(record.context.project));
  if (kind === 'check') {
    lines.push(`项目输入${record.context?.input_changed === undefined ? '变化未保存' : record.context.input_changed ? '已变化' : '未变化'}；任务约定${record.context?.terms_changed === undefined ? '变化未保存' : record.context.terms_changed ? '已变化' : '未变化'}`);
    for (const row of record.model?.workflow.comparisons ?? []) {
      const t = summary.tasks.find(t => t.task === row.task_key)!;
      lines.push(`${row.task_key}  ${state(row.reported_status)}${row.current_verification ? '；当前验证 ' + state(row.current_verification) : ''}`);
      for (const s of t.stages) lines.push(`  ${s.phase}：任务 ${state(s.task)}；边界 ${state(s.boundaries)}${s.protections ? '；保护 ' + state(s.protections) : ''}`);
      const reason = saved(row.reason); if (reason) notices.push(`${row.task_key}：${reason}`);
      if (row.terms?.changed) notices.push(`${row.task_key}：${names(row.terms.changes.map(c => c.dimension))} 已变化；通过当前检查不代表保留了旧要求。`);
      if (row.suggestion_verified.state === 'recorded' && row.suggestion_verified.value) notices.push(`${row.task_key}：有修复建议，尚未采用；需审阅新增授权。`);
      notices.push(...executionProblems(record.children.filter(c => c.task === row.task_key).flatMap(c => c.result?.executions ?? [])));
    }
    if (record.context?.limits_changed) notices.push('可信上限已变化，需审阅本次授权条件。');
    if (record.context?.environment_changed?.length) notices.push('环境变化：' + names(record.context.environment_changed));
    footer.push('基线未自动更新。');
  } else if (kind !== 'compare') {
    for (const t of summary.tasks) {
      const values = selected(record, t.task), task = get(t, 'task'), boundary = get(t, 'boundaries'), protection = get(t, 'protections');
      const observation = record.usage?.tasks.find(r => r.task === t.task) ?? values.flatMap(v => { const r = saved(v.facts.observations.records); return r ? [r] : []; })[0];
      const historical = kind === 'adopt' ? '历史验证 ' : '';
      lines.push(`${t.task}  ${historical}${state(task?.status ?? (observation?.capture_status !== 'not_run' ? observation?.verdict : undefined))}${values.length ? ` · ${values.length} 次记录` : ''}`);
      const definition = record.model?.tasks.find(d => d.key === t.task)?.definition;
      if (definition?.state === 'recorded' && definition.value.success_conditions.some(a => a.type === 'exit_code')) lines.push(`  验收：${definition.value.success_conditions.every(a => a.type === 'exit_code') ? '仅退出码 0，依靠命令自身检查' : '退出码 0 与声明的文件检查共同通过'}`);
      if (boundary) lines.push(`  固定边界检查${state(boundary.status)}${protection ? '；保护目标' + state(protection.status) : '；未声明额外保护目标'}`);
      const policy = t.policy ?? values[0]?.policy;
      if (policy && kind !== 'doctor') lines.push(...policyLines(policy).map(s => '  可变授权 · ' + s));
      if (observation) {
        if (observation.capture_status === 'not_run') notices.push(t.task + '：观察未执行；' + observation.reason);
        else {
          lines.push(`  安装清单：${observation.inventory ? `${observation.inventory.packages.length} 个包实例${observation.inventory.complete ? '' : '（不完整）'}` : '未保存'}`,
            `  Node 加载：${observation.loaded_packages.length} 个包实例（${state(observation.load_capture_status ?? observation.module_capture_status ?? observation.capture_status)}）`);
          if (observation.resolution_capture_status) lines.push(`  解析明细：${observation.edges?.length ?? 0} 条关系（${state(observation.resolution_capture_status)}）`);
          if (observation.compilation) lines.push(`  TypeScript 输入：${observation.compilation.files.length} 个文件、${observation.compilation.packages.length} 个包实例（${state(observation.compilation.capture_status)}）`);
          if (observation.bundling) {
            const b = observation.bundling;
            lines.push(`  产物输入：${b.inputs.length} 个文件、${b.packages.length} 个依赖包实例（${state(b.capture_status)}）`);
            if (b.capture_status === 'captured' && b.bundler && observation.loaded_packages.some(p => p.path === b.bundler!.path) && !b.packages.some(p => p.path === b.bundler!.path)) lines.push(`  ${b.bundler.name} 被加载，未作为输入进入本次产物。`);
          }
          if (observation.coverage_gaps?.length) notices.push(`${t.task}：Node 加载记录存在 ${observation.coverage_gaps.length} 项覆盖范围限制（包括原生/其他子进程）；详情可查。`);
          notices.push(...(observation.issues ?? []).map(s => `${t.task}：${s}`), ...observation.inventory?.issues.map(s => `${t.task}：${s}`) ?? [], ...observation.compilation?.issues.map(s => `${t.task}：${s}`) ?? [], ...observation.bundling?.issues.map(s => `${t.task}：${s}`) ?? []);
        }
      }
      if (kind === 'tighten') for (const search of record.model?.workflow.searches.filter(s => s.task_key === t.task) ?? []) {
        const reductions = t.decisions.filter(d => d.scope_change === 'reported_reduction' && d.support === 'corroborated').length;
        lines.push(`  ${({read:'读取',write:'写入',network:'安装网络',install_write:'安装写入'} as Record<string,string>)[search.permission] ?? search.permission}搜索：${state(search.stop)}；记录接受 ${search.decisions.filter(d => d === 'accepted').length} 项`);
        if (!['exhausted', 'fixed_point'].includes(search.stop)) notices.push(`${t.task}：搜索因 ${state(search.stop)} 停止；已验证规则与未完成搜索需分别看待。`);
        if (!reductions && search.decisions.includes('accepted')) lines.push('  接受操作不等于实际访问范围减少，需核对候选与恢复依据。');
      }
      notices.push(...executionProblems(values));
    }
    if (kind === 'doctor') footer.push('覆盖内置环境检查；项目规则需另行验证。');
    if (kind === 'tighten') footer.push('结果限于本轮候选与任务，未证明全局最小权限；尚未采用。');
    if (kind === 'observe') footer.push('记录限于本次采集来源；未记录不代表依赖没有用途。');
    if (kind === 'adopt') {
      footer.push('采用不执行当前项目；代码或环境变化后使用 check 复验。', '执行：任务 0 次，安装 0 次。');
      if (record.adoption?.manifest.reason) lines.push('采用理由：' + record.adoption.manifest.reason);
    }
    if (record.native) notices.push('这是单次执行记录；不能据此确认整个工作流完成。');
  }
  if (record.comparison) {
    lines.push(...compareLines(record.comparison));
    notices.push(...record.comparison.tasks.flatMap(t => [...t.warnings, ...t.compilation?.warnings ?? [], ...t.bundling?.warnings ?? []]));
    footer.push('记录差异不代表可删除依赖或权限回归。');
  }
  const costSource = record.cost ? record : record.executionReport, cost = costSource?.cost;
  if (cost && kind !== 'adopt') {
    const executions = costSource!.executions.length ? costSource!.executions : costSource!.children.flatMap(c => c.result?.executions ?? []);
    const processes = executions.filter(e => e.facts.process.state === 'recorded').length;
    const installs = executions.filter(e => saved(saved(e.facts.installation)?.reused) === false).length;
    const unknownInstall = executions.some(e => e.facts.installation.state === 'recorded' && saved(saved(e.facts.installation)?.reused) === undefined);
    footer.push(`执行记录：${cost.trials} 次实验；${executions.length === cost.trials ? `任务进程记录 ${processes} 次，安装进程记录 ${installs} 次${unknownInstall ? '（另有安装/复用状态未保存）' : ''}` : '任务/安装次数依据不完整'}${cost.duration_ms !== undefined ? `；${(cost.duration_ms / 1000).toFixed(2)} 秒` : ''}`);
  }
  if (kind === 'compare') footer.push('本次只读比较，任务 0 次、安装 0 次。');
  if (summary.analysis.gaps.length) notices.push(`材料缺口：${summary.analysis.gaps.length} 项；${summary.analysis.gaps[0]}`);
  view.notices = unique(notices);
  return view;
}

export function terminalText(view: TerminalView, options: { details?: boolean; inspect?: boolean; cwd?: string; hint?: string } = {}): string {
  const lines = [...options.inspect ? ['查看已保存结果 · 未重新执行项目'] : [], view.title, '',
    ...view.notices.map(s => '注意：' + s), ...options.details ? view.lines : view.lines.slice(0, 24),
    ...!options.details && view.lines.length > 24 ? [`另有 ${view.lines.length - 24} 行结果；加 --details 展开。`] : [],
    ...view.footer,
    '', ...view.result ? ['结果：' + displayPath(view.result.endsWith('/report.json') || view.result.endsWith('/usage.json') ? path.dirname(view.result) : view.result, options.cwd)] : [],
    ...options.details ? ['', ...view.details] : [options.hint ?? (view.result ? '查看依据（只读）：' + cliCommand(['inspect', view.result, '--details']) : '给当前只读比较命令加 --details 查看完整记录；--json 输出结构化数据。')]];
  return lines.map(cleanText).join('\n');
}

export function configurationText(r: ConfigurationExplanation, details?: string): string {
  if (details) return details.split('\n').map(cleanText).join('\n');
  const lines = [`配置${r.status === 'valid' ? '静态检查通过' : '无效'} · 用于 ${r.for}`, '预览未执行任务或安装。',
    ...r.project ? ['项目：' + displayPath(r.project.resolved ?? r.project.configured)] : [],
    ...r.issues.map(i => `需要修正：${displayPath(i.file)} ${i.path}：${i.message}`),
    ...r.tasks.flatMap(t => [`${t.id}：${t.executed_command.map(shellToken).join(' ')}`,
      `  写 ${names(t.task.write.grants)}；读 ${t.task.read.mode === 'legacy' ? '项目副本整体（默认）' : t.task.read.grants.length ? names(t.task.read.grants) : '未授权项目文件读取（固定运行时读取保留）'}；任务断网`,
      ...t.installation ? [`  安装：npm ci，禁用脚本，${t.installation.offline ? '离线缓存' : '冷缓存'}；域名 ${names(t.installation.network.grants)}`] : [],
      ...t.observation.active ? [`  采集：${names(['Node 加载', ...t.observation.typescript ? ['TypeScript 输入'] : [], ...t.observation.esbuild ? ['esbuild 产物输入'] : []])}`] : [],
      `  成功检查：${t.artifacts.reduce((n, a) => n + a.checks.length, 0) + t.process_checks.length} 项；固定保护：${t.task.protection_goals?.length ?? 0} 项`,
      ...t.process_checks.length ? ['  退出码验收：任务正常完成且退出码 0；检查强度由命令自身的检查决定。'] : [],
      ...t.artifacts.map(a => `  ${a.path}：${a.checks.map(c => c.assertion.type === 'test_results' ? `预期 ${c.assertion.expected_tests.length} 项名称，报告全部测试须通过` : c.assertion.type === 'junit' ? `预期 ${c.assertion.expected_tests.length} 项名称，全部测试须通过且统计一致` : c.assertion.type === 'json_equals' ? `JSON ${c.assertion.pointer || '(根值)'} 等于 ${JSON.stringify(c.assertion.value)}` : c.assertion.type === 'file_contains' ? `包含 ${JSON.stringify(c.assertion.text)}` : '普通文件存在（不检查内容）').join('；')}`),
      ...t.assertion_outputs_removed.length ? [`  副本预先清理 ${t.assertion_outputs_removed.length} 份待验收产物。`] : [],
      ...t.observation_output_root_removed ? [`  隔离副本中会清空产物目录：${t.observation_output_root_removed}`] : []]),
    ...r.schedule ? [`计划：${r.schedule.nominal_task_executions ?? '次数动态确定'} 次任务；${r.schedule.nominal_installations ?? '次数动态确定'} 次安装；预算 ${r.schedule.budget_seconds} 秒（失败可能提前停止）`] : [],
    '静态检查未验证任务、边界或产物；@workspace 是隔离项目副本。',
    '加 --details 查看上限、成功条件、默认值及准备/清理范围。'];
  return lines.map(cleanText).join('\n');
}
export function packageText(r: PackageInspection, details = false): string {
  const cell = (s: {capture_status:string;record:string;files:number|null}) => s.capture_status === 'not_collected' || s.capture_status === 'not_run' ? state(s.capture_status) :
    `${s.record === 'absent' ? '无记录' : s.files === null ? '文件清单未保存' : s.files + ' 个文件'}（${state(s.capture_status)}）`;
  return [`依赖记录 · ${r.package}${r.status === 'partial' ? ' · 分析不完整' : ''}`, '只读保存记录，未执行项目。',
    ...r.tasks.flatMap(t => [`${t.task}：记录的任务 ${state(t.verdict)}`, ...t.instances.flatMap(p => [
      `  ${p.name}@${p.version} · ${p.path}`, `  Node 加载：${cell(p.node)}；TypeScript 输入：${cell(p.typescript)}`,
      `  esbuild 输入：${cell(p.esbuild)}`,
      ...p.esbuild.contributions.map(c => `  ${c.output}：${c.bytes_in_output} 字节贡献`), ...packageContextLines(p, details).map(s => '  ' + s)]),
      ...!t.instances.length ? [t.inventory === 'complete' ? '  完整安装清单中没有此包实例。' : '  没有此包记录，安装清单不完整或未保存。'] : [],
      ...t.issues.length ? [`  覆盖/采集提示：${t.issues.length} 项${details ? '' : '，加 --details 查看'}`, ...details ? t.issues.map(s => '  ' + s) : []] : []]),
    '未采集、无记录和零字节贡献不同；这些记录不能直接判定依赖可删除。',
    '来源：' + displayPath(r.report), ...details ? r.limitations : []].map(cleanText).join('\n');
}
export function diagnosticText(r: SuccessDiagnostic, details = false): string {
  return [`成功条件诊断${r.status === 'partial' ? '不完整' : '完成'} · 未执行项目或安装`,
    ...r.tasks.flatMap(t => [`${t.task}：${state(t.state)}${t.reason ? '；' + t.reason : ''}`, ...t.artifacts.flatMap(a => [
      `  ${a.path}：${state(a.state)}${a.reason ? '；' + a.reason : ''}`, ...a.findings.map(s => '  发现：' + (diagnosticFindings[s] ?? s)),
      ...details ? a.mutations.map(m => `  ${m.description}：产物检查${m.artifact_checks_reject ? '拒绝' : '接受'}；格式/内容原因 ${names(m.checks.filter(c => c.status !== 'pass').map(c => c.cause))}`) : []])]),
    '诊断只检查保存产物的验收条件，不判断报告诚实性或任务内部行为。', '来源：' + displayPath(r.source),
    ...details ? r.limitations : ['加 --details 查看扰动结果与检查范围。']].map(cleanText).join('\n');
}
export const shellToken = (s: string) => /^[A-Za-z0-9_./@-]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\\''") + "'";
function cliCommand(args: string[]): string {
  const script = process.argv[1];
  return [...script && /[\\/]cli\.js$/.test(script) ? ['node', displayPath(script)] : ['permsift'], ...args.map(a => path.isAbsolute(a) ? displayPath(a) : a)].map(shellToken).join(' ');
}
const diagnosticFindings: Record<string, string> = {
  'The artifact checks accept an empty readable file. They check existence, not useful content; task-internal behavior tests were not re-run.': '这些产物检查接受空文件，只验证存在；任务内部行为测试没有重跑。',
  'Tests outside the expected-name list must also pass. Expected names are a required subset, not the only tests checked.': '预期名称列表之外的测试也必须通过；预期列表是必须包含的子集。',
  'Removing this non-expected test remains accepted; the configured expected-name list does not require that test.': '删去这项非预期测试仍被接受，当前名称列表没有要求它必须出现。',
  'Keeping only the checked text remains accepted. This identifies the content check scope; it does not prove the task would accept a broken build.': '只保留被检查的文本仍被接受；这说明内容检查范围有限，不能据此判定坏构建会通过整个任务。',
  'An empty file is rejected for invalid structured format. Semantic value/test changes are reported separately.': '空文件因结构格式无效被拒绝；内容值和测试状态的扰动结论另列。',
  'If nonempty or meaningful content is part of success, add a suitable content assertion or a task behavior check. Existence alone does not express that requirement.': '若成功要求非空或有意义的内容，应添加内容断言或行为检查；文件存在不足以表达这项要求。',
};
