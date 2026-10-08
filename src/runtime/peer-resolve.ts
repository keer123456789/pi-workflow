/**
 * 共享对等依赖探测（M4/T1 自 llm-pi-ai.ts 逐字平移）：`createRequire` 失败退
 * `import.meta.resolve` 的两步机制，`probePeerPackage(pkg)` 供各适配器复用
 * （M2 的 pi-ai、M4 的 pi-coding-agent——后者的 exports map 同样无 `"require"`
 * 条件，D28）。是否缓存由调用方决定（D13/D28：结果进程内缓存）。
 *
 * `src/runtime/` 是适配器的**物理隔离区**：对等依赖只按名解析/动态加载，从不静态
 * import；本模块是唯一承载 `node:module` 的 `createRequire` 的地方（M4/T1 起）。
 */

import { createRequire } from "node:module";

/**
 * 真实探测：`createRequire(import.meta.url).resolve(pkg)`（D13 指定机制）在 try/catch
 * 里；它失败时退到 `import.meta.resolve(pkg)`。**永不抛**（探测失败 = `false`）。
 *
 * 为什么要退一步（对 pi-ai@1.0.4 实测）：其 `exports` map 的 `"."` 只声明了
 * `"types"`/`"import"` 两个条件——**没有 `"require"`/`"default"`**，而 `require.resolve`
 * 按 CJS 条件解析，必然 `ERR_PACKAGE_PATH_NOT_EXPORTED`：只按字面实现会让探测在
 * "装好了"时也报 false，默认实现永远接不上。`import.meta.resolve` 走 ESM 条件，正是
 * 本库（ESM-only）该用的机制；本仓库 Node ≥22，它在 22/24 与 vitest 下都可用。
 */
export function probePeerPackage(pkg: string): boolean {
	try {
		createRequire(import.meta.url).resolve(pkg);
		return true;
	} catch {
		// 落到 ESM 条件兜底（见上）；老环境/打包器里 import.meta.resolve 可能没有 → false。
	}
	try {
		// 返回值按 `unknown` 收：打包器/自定义 loader 的 shim 可能返回 Promise 之类的
		// 非字符串——`!== undefined` 会把它们误判成"可用"；只认字符串（判定不看其 settle）。
		const resolve = (
			import.meta as ImportMeta & {
				resolve?: (specifier: string) => unknown;
			}
		).resolve;
		return typeof resolve === "function"
			? typeof resolve(pkg) === "string"
			: false;
	} catch {
		return false;
	}
}
