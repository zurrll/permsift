# 第三方项目 clsx 验证

选用 [lukeed/clsx](https://github.com/lukeed/clsx)，固定提交 [925494cf31bcd97d3337aacd34e659e80cae7fe2](https://github.com/lukeed/clsx/tree/925494cf31bcd97d3337aacd34e659e80cae7fe2)，package.json 版本 2.1.1，上游许可证 MIT。它有实际构建脚本、terser 依赖和多种发布产物，适合先验证权限调试流程；规模较小，不能代表大型生产项目。

## 复现

```sh
npm ci --ignore-scripts
npm run third-party:prepare
npm run third-party:verify
```

prepare 从上游获取固定提交，保存到忽略目录 .permsift/third-party/clsx。若目录已经存在，必须仍指向该提交和远端，且已跟踪文件未修改；不自动重置已有内容。使用仓库中锁定的 package-lock.json 安装开发依赖，禁用生命周期脚本。这个准备阶段联网，不参加权限搜索。

verify 在 macOS 的真实沙箱里运行，任务阶段始终断网。场景配置、锁文件和 limits 位于 examples/third-party/clsx；没有复制或改写上游构建源码。锁文件由固定提交的 package.json 生成，并额外放入下载副本，作为已准备输入。

## 实际执行什么

场景直接加载上游 bin/index.js，使用 terser 完成原始构建。然后加载 dist 的完整 CJS、ESM、UMD 和 lite CJS、ESM 五个变体，断言嵌套数组、条件对象、空值和 lite 过滤行为，共 8 项行为断言。成功后新生成 smoke JSON；宿主检查五个产物存在、smoke 状态和变体数量。

这是原始构建加产物行为检查，**没有运行完整上游 uvu 测试套件**，也没有覆盖所有输入分支。规则仅适用于这个任务和这组断言；需要运行上游测试时应另建场景。

初始读写范围覆盖工作区，另允许写缓存和临时目录。未填写手工候选。读取枚举深度设为 2，使项目源码可细分到文件、依赖可细分到包目录；更深的依赖输入暂不展开，报告会标注 truncated。这个设置减少重复复制依赖和试验文档文件的成本。

verify 要求搜索及最终复验通过，并确认写权限只剩 dist、读取不再覆盖整个工作区和测试树。随后从干净输入重放导出的策略 3 次，并比较输入哈希。每次生成独立 clsx-read-* 目录，summary.json 记录提交、次数、耗时、权限、哈希和报告位置。已有旧版本 summary.json 时，可用 `npm run third-party:verify -- --baseline PATH` 保存 comparison.json，核对输入、环境、规则和次数。具体本机结果见 [validation.md](validation.md)。

## 能从这次实验学到什么

读取产物是构建 smoke test 的必要条件，只有输出写授权不足以完成任务。package.json 也可能参与模块加载，即使主命令不是 npm；必要性要由失败与恢复证据判断。

未使用的测试文件、说明文件和开发依赖可以在当前任务里撤销读取。底层运行时和系统读取仍然较宽，这次结果描述的是项目内授权收缩。第一次深度较大的探索用完候选预算，仍完整复验了保留策略，但没有完成搜索；最终配置采用先删除目录再展开的顺序，并将依赖展开限制在包层。预算和候选顺序确实影响探索成本及结果，不能把某一次结果当作全局最优策略。
