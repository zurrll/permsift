# 第一次试用

当前交付为 v0.12 的本地源码试用包，尚未发布到 npm。任务执行需要 macOS、Node 22+、配套 npm 和系统 sandbox-exec；模块观察需要 Node 22.15+ 或 23.5+。首次只选一个问题：维护权限，或理解任务的依赖记录。下面的演示不代表你的项目已经获准相同上限。

## 安装与两条入口

将 `permsift-0.12.0-trial.tar.gz` 解压到一个新目录，进入 `permsift/`。源码包不带 node_modules、dist、Git 数据或历史报告；`TRIAL-MANIFEST.json` 记录文件摘要和来源，摘要用于一致性检查，不是发行者签名。需要 Git 历史时请使用开发仓库。

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js explain --config examples/demo/permsift.yaml --limits examples/limits.json
node dist/cli.js doctor
```

选 [权限入门](getting-started-permissions.md)，可先 run → inspect → adopt 已验证的 run → 改动 → check。demo 两项任务各重复三次；run 六次，兼容 check 六次，没有额外安装。不需要收缩时不必 tighten；run 的通过只验证初始方案，并没有缩小权限。

选 [依赖观察入门](getting-started-observation.md)，先 explain，再显式 `npm run examples:prepare`，然后 observe → inspect。准备会在宿主安装 bundle-kit 和 cached-build 两个示例的固定依赖，禁用生命周期脚本；两次观察各只构建一次。比较需要真实输入变化，否则没有对应差异也正常。

保存完整结果目录，尤其 report、inputs、evidence、executions 和 usage；只保存终端截图无法复查。第一次接入自己的项目先保留原命令，明确有信息量的成功条件、少量保护目标和可信 limits。先验证一个任务，再决定是否值得增加任务、安装或搜索。

## 自动复现干净接入

开发仓库中 `npm run trial:bundle` 只导出 Git 已跟踪/已加入索引的当前文件，未跟踪文件不会自动打包；输出到新的 `.permsift/trial-bundle-*`。`git_status` 记录未提交状态，不把当前字节冒充 HEAD。解压后的源码包没有 Git 时，按原清单校验并重新导出；清单中的源码若已改动，校验会失败。不会发布、推送或带入本地依赖。

```sh
# macOS；从源码包、新目录、新 npm 缓存重新安装工具并走两份入门
npm run trial:verify
# 或校验指定试用包
npm run trial:verify -- --bundle /absolute/path/permsift-0.12.0-trial.tar.gz
```

默认成本：一次工具安装、两次示例宿主安装、一次 doctor、14 次项目任务（权限 12 次，观察 2 次），0 次沙箱安装、0 次搜索。输出使用新目录；已存在的输出拒绝覆盖。脚本先比对源码清单，确认没有旧依赖或产物，再安装。运行过程的 stdout/stderr、失败状态、尝试次数和分项时间写入 `.permsift/clean-trial-*/verification.json`，失败不自动重试。相同主机的干净目录不能替代另一主机或独立用户试用。

## 一次外部项目维护流程

[glob-parent 固定维护示例](../examples/third-party/glob-parent-maintenance/README.md) 回答：“原测试通过且源码禁止改写的规则，升级测试工具后还可继续用吗？保存记录能否点出实际版本变化？”

```sh
# 首次获取固定源码，显式准备两个锁文件的缓存，再做四次离线沙箱安装
npm run external:verify
# 连同干净接入检验；明确增加两次缓存准备及四次沙箱安装
npm run trial:verify -- --with-maintenance
# 确实需要验证冷下载时，另外选择；不自动回退到暖缓存
npm run external:verify -- --cold
```

单个上游测试任务，run → adopt → observe，替换固定锁文件中的 Mocha 7.1.2 → 7.2.0，再 check → observe → 审阅后 adopt → 离线查询/比较。默认在新副本中显式执行两次宿主 npm ci（禁用脚本、共用全新缓存），清理 node_modules，冻结同时含两个版本的种子；之后四次沙箱各从原始输入执行新的 `npm ci --offline`，没有直接复用宿主安装的依赖树。种子摘要是结论的输入条件，两次版本观察和复验使用同一种子。

单次执行 180 秒预算，零搜索；已有权限需仍支持本次测试和两条固定保护目标。外部项目失败会保存收据并停止，不以新的重跑隐藏成本。冷下载曾出现耗时和超时，所以默认维护检验选择固定缓存；这不证明冷联网安装稳定。`--cold` 单独选择四次注册表安装、不准备宿主缓存，超时仍为未知，不能当作权限失败。开发者已有该 Git 对象时可传 `--upstream /absolute/path/checkout`；只导出指定提交，忽略工作树改动和旧依赖，收据记录来源。

依赖网络和固定老工具链可能成为阻碍。未知、失败、报告不完整和兼容是不同结果；先读 summary.md、verification.json 与 stderr。源项目支持限制见 [安装范围](dependency-install.md)，环境失败先看 doctor。样例是在固定历史版本上检验流程，不是建议使用这些旧版本。

## 请记录真实使用结果

可以复制 [反馈模板](trial-feedback.md)，和收据一起保存在本地。无需把完整源码、凭据或依赖树交给工具作者；提交反馈时先自行确认材料内容。

有价值的反馈是：你带来的问题、成功前的阻碍、根据报告作出的判断、该判断之后怎样验证，以及一次变更后还能否使用。工程测试通过不证明接入容易或节省时间；只有实际记录时才报告人工耗时。若报告没有帮助任何决定，这也是应保留的结果。
