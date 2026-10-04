import { cleanText } from './terminal.js';

export type ProgressEvent = { task: string; phase: string; attempt: number; repetitions?: number;
  stage: 'prepare' | 'install' | 'task'; comparison?: string };
const phases: Record<string, string> = { baseline: '初始验证', final: '最终验证', observe: '观察', discovery_baseline: '发现后复验',
  installation_snapshot: '建立安装快照', candidate: '尝试写入收缩', candidate_read: '尝试读取收缩', candidate_network: '尝试安装网络收缩',
  candidate_install: '尝试安装写入收缩', recovery_install: '恢复安装写入规则', recovery: '恢复验证', recovery_read: '恢复读取规则', recovery_network: '恢复安装网络规则',
  old: '旧规则复验', control: '宽规则对照', 'old-confirm': '确认旧规则失败', 'control-confirm': '确认宽规则恢复', new: '验证新增任务' };
export function progressText(e: ProgressEvent): string {
  const phase = e.comparison ? phases[e.comparison] ?? (e.comparison.startsWith('control-recovery-') ? '恢复宽规则对照' : e.comparison.startsWith('repair-verify-') ? '验证修复建议' : '尝试修复') : phases[e.phase] ?? '实验';
  const repetition = e.repetitions ? `${e.attempt}/${e.repetitions}` : `第 ${e.attempt} 次`;
  return cleanText(`${e.task} · ${phase} ${repetition} · ${{prepare:'准备与前置检查',install:'安装依赖',task:'执行任务'}[e.stage]}`);
}
/** TTY updates one line; pipes/logs get ordinary lines without terminal escape sequences. */
export function progressWriter(stream: { isTTY?: boolean; columns?: number; write(s: string): unknown }) {
  let active = false;
  const finish = () => { if (active) { stream.write('\n'); active = false; } };
  return { event(e: ProgressEvent) {
    const line = progressText(e);
    if (stream.isTTY) {
      const limit = Math.max(8, (stream.columns ?? 80) - 1);
      let visible = '', width = 0;
      for (const character of line) {
        const n = character.codePointAt(0)! > 255 ? 2 : 1;
        if (width + n > limit - 2) { visible += '…'; break; }
        visible += character; width += n;
      }
      stream.write('\r\u001b[2K' + visible); active = true;
    }
    else stream.write(line + '\n');
  }, message(s: string) { finish(); stream.write(cleanText(s) + '\n'); }, finish };
}
