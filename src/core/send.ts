/**
 * Send：router 返回的"显式实例"目标（设计 §5.3）。
 *
 * 每个 Send 都生成目标节点的一个实例（不去重），`input` 即该实例的输入；
 * 实例返回值经目标节点的 `writeTo` key 的 reducer 汇入全局 state。
 */
export class Send<I = unknown> {
	constructor(
		readonly node: string,
		readonly input: I,
	) {}
}
