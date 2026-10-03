# glob-parent 的一次测试工具升级

源码：gulpjs/glob-parent，固定提交 `26ce5ecec10c687cffb9891c108fb2d2800b9140`，版本 6.0.2，ISC 许可。准备脚本通过 Git 导出该对象，保留 LICENSE，不改源码、package.json、测试或原测试流程。

原任务 `npm test` 会先 lint，再由 nyc 执行 Mocha `--async-only`；本例仅追加 xunit reporter 输出到 test.xunit。列出 macOS 上注册的全部 20 个测试名，包括四项耗时回归；Windows 专有条件用例不在当前 macOS 任务中。JUnit 检查全部报告项通过、没有重名、20 个预期名字都在；它不独立验证报告诚实。

`package-lock.before.json` 和 `package-lock.after.json` 是可复现输入，不在运行时重新解析浮动版本。两个 v3 锁文件的 packages 条目只改变 `node_modules/mocha`：7.1.2 → 7.2.0，仍满足上游 `^7.1.2`。本例锁定 435 个安装实例；文件摘要分别为：

- before：`f006f5181d185a8681794240e170c94101f68aae54aa7061e9b5c3bc9dcc3d24`
- after：`801327e05cfe19f33b185503bf2c94e6eb92eb1d592eca0676f7317cb4f5401e`

`permsift.yaml` 将项目指向相邻 project。自动检验会将路径改到独立副本并保留所有其他声明；只有锁文件在维护时替换，配置和 limits 不变。默认先在副本中显式执行两次宿主 npm ci，禁用脚本、全新缓存收齐两版内容，然后清理 node_modules，缓存作为 seed 输入；沙箱每次独立 `npm ci --offline`，不是直接复用宿主依赖树。安装可写 node_modules、cache、tmp；任务离线，工作区和 tmp 可写，并固定禁止写 index.js 和 test/。输出报告在根目录，所以仍保留工作区写范围；没有声称已达到最小权限。保护目标只覆盖任务阶段的声明操作及前后对照，不覆盖安装。

在工具根目录 `npm run external:verify` 完成：一次初始 run 与采用、升级前观察、锁文件变化后的 check、升级后观察、审阅后采用、删除临时项目后的离线 Mocha 查询和比较。两次宿主缓存准备、四次沙箱新安装、四次原测试任务、零候选；每次执行预算 180 秒。种子在四次执行间不变，摘要进入收据和原生安装记录；结果限定于此输入条件。CLI 失败立即保留当前收据，没有自动网络重试或额外搜索。可以从命令日志手动复现各步，使用独立输出目录。

另选 `npm run external:verify -- --cold`：跳过宿主缓存准备，派生为 cold / registry.npmjs.org 网络授权，每次联网安装。此前冷安装实测有 74 秒和 150 秒超时样本，因此不拿它当日常维护检查的固定成本；失败不静默切换条件。

此任务观察 Node 模块，不采集编译/产物来源；加载的包不能自动分成“业务用包”和“只是工具”，没有记录也不等于可删除。Mocha 的版本变化是测试工具链线索，需结合原命令解释；一次通过不能保证任意升级或其他环境均安全。首次获取源码、工具安装、沙箱安装和离线分析分别计成本。
