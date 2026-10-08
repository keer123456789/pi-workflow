/**
 * pi CLI 子进程适配器（设计 §9.2；协议细节以 M0 冻结的 docs/runtime-protocol.md 为准）。
 *
 * **实现归 Task 3，本模块当前只承载配置类型**：spawn / stdin 传 task（D17）、
 * JSONL 事件流解析、双层成败判定（D16）、杀树（D19）、版本探测（D18）都在
 * 后续任务落地。
 *
 * 隔离边界：`node:child_process` 只允许出现在本文件（Global Constraints）；
 * core 对本模块只做 **type-only import**（同 `executor.ts` 的约定——运行时零耦合）。
 */

/**
 * subprocess 适配器的启动配置（设计 §4.6 verbatim）：字段全可选——空对象 `{}` 即
 * 接受全部默认（D20：compile 期只校验配置存在，`{}` 合法）。
 */
export type PiSubprocessConfig = {
	/** pi CLI 可执行文件（缺省 `"pi"`，经 PATH 解析；shim 测试也用它指向假 pi）。 */
	bin?: string;
	/** 子进程工作目录（缺省 `process.cwd()`）。 */
	cwd?: string;
	/** 注入子进程的环境变量（在 `process.env` 之上合并，同键覆盖）。 */
	env?: NodeJS.ProcessEnv;
	/** 追加到命令行的额外参数（排在协议前缀参数与 model/tools 之后，原样透传）。 */
	extraArgs?: string[];
	/** 节点未声明 `model` 时的默认模型（D23：`cfg.model ?? defaultModel`，都无则不带 `--model`）。 */
	defaultModel?: string;
};
