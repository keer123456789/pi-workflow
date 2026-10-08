/**
 * pi SDK 进程内适配器（设计 §9.3；M4）。
 *
 * **实现归 Task 2，本模块当前只承载配置类型**：createAgentSession 会话装配与
 * dispose 生命周期（D25）、ModelRuntime.create 的 model 解析（D27）、prompt 后的
 * verdict（D24）、共享探测（D28）与 usage 映射（D29）的接线都在后续任务落地
 * （镜像 M3/T1 的 pi-subprocess.ts 先例：先类型占位、后实现）。
 *
 * 隔离边界：`src/runtime/` 是适配器的**物理隔离区**（同 `pi-subprocess.ts` /
 * `llm-pi-ai.ts` 的惯例）——对等依赖 `@earendil-works/pi-coding-agent` 只按名
 * 解析/动态加载，从不静态 import；core 对本模块只做 **type-only import**
 * （`import type` 编译期擦除——运行时零耦合）。类型 `PiSdkConfig` 经
 * `src/index.ts` 公开；适配器本体（`createPiSdkExecutor` 等）不进公开面
 * （同 `llm-pi-ai.ts` 的先例：供 compile 解析与高级用户直接接线用）。
 */

/**
 * PiSdkConfig（§4.6；D25/D27 冻结形状）
 */
export type PiSdkConfig = {
	/** pi agent 目录（auth.json/models.json 所在）。缺省 = pi 默认（PI_CODING_AGENT_DIR 或 ~/.pi/agent）。 */
	agentDir?: string;
	/** 会话工作目录（资源发现与内置工具路径）。缺省 = process.cwd()。 */
	cwd?: string;
	/** 节点未声明 model 时的兜底模型串 "<provider>/<id>"（D23 优先级：cfg.model ?? defaultModel）。 */
	defaultModel?: string;
};
