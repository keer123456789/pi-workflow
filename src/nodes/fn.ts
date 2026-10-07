/**
 * fnNode：把普通函数包装成节点定义（设计 §4.3）。
 *
 * - `name` 留空串占位——名字属于"注册"而非"定义"，由 StateGraph.addNode 回填；
 * - 不提供 retry（fn 失败是代码错误，重试无意义，设计 §7.1）；
 * - 每次调用返回新对象，注册时可按注册名独立回填。
 */

import type { NodeDefinition, NodeHandler } from "../core/types.js";

export function fnNode<S extends object, I = S>(
	handler: NodeHandler<S, I>,
	opts?: { timeoutMs?: number },
): NodeDefinition<S, I> {
	return { kind: "fn", name: "", handler, timeoutMs: opts?.timeoutMs };
}
