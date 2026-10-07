/**
 * channel / reducer 与状态折叠（leaf 模块：除 InvalidWriteError 与 type-only 的
 * `TSchema` 外无任何 import、无 I/O）。
 *
 * 职责边界（R7）：
 * - 标准 reducer 是纯函数，检测到非法写入时抛普通 `Error`（它们不持有 writer 信息，
 *   不构造 InvalidWriteError）；
 * - `foldUpdates` 是唯一把 reducer 错误统一包装成 `InvalidWriteError` 的地方（保留 cause）。
 */

import type { TSchema } from "typebox";

import { InvalidWriteError } from "./errors.js";

/** 单个 channel 的合并函数：`current` 为已折叠值，`update` 为本次写入值。 */
export type Reducer<V> = (current: V, update: V) => V;

/** 状态 schema：为 S 的部分 key 声明 reducer；未声明的 key 走 last-value 覆盖。 */
export type StateSchema<S> = Partial<{ [K in keyof S]: Reducer<S[K]> }>;

/** 默认语义：后写覆盖；任何值（含 null / undefined）都照写。 */
// biome-ignore lint/suspicious/noExplicitAny: 对外签名按任务 brief verbatim（Reducer<any>，设计 §4.5）
export const overwrite: Reducer<any> = (_current, update) => update;

/**
 * 数组拼接（返回新数组，不修改 current / update）。
 * 任一侧非数组 → 抛普通 Error，消息含两侧值的简短描述。
 */
// biome-ignore lint/suspicious/noExplicitAny: 对外签名按任务 brief verbatim（Reducer<any[]>，设计 §4.5）
export const append: Reducer<any[]> = (current, update) => {
	if (!Array.isArray(current) || !Array.isArray(update)) {
		throw new Error(
			`append: expected arrays, got current=${describeValue(current)}, update=${describeValue(update)}`,
		);
	}
	return [...current, ...update];
};

/** 字符串拼接。 */
export const concat: Reducer<string> = (current, update) =>
	`${current}${update}`;

/**
 * 只允许写一次（用于"最终产物"）。
 * 约定：`undefined` 表示尚未写过；其余任何值（含 null）都视为已写过 → 抛普通 Error。
 */
// biome-ignore lint/suspicious/noExplicitAny: 对外签名按任务 brief verbatim（Reducer<any>，设计 §4.5）
export const setOnce: Reducer<any> = (current, update) => {
	if (current !== undefined) {
		throw new Error(
			`setOnce: channel already written (current=${describeValue(current)}); setOnce accepts exactly one write`,
		);
	}
	return update;
};

/** 单条 channel 写入；`writer` 为写入者标识（引擎里是节点名）。 */
export type ChannelUpdate = {
	key: string;
	value: unknown;
	writer: string;
};

/**
 * 把 updates（调用方已按全局 seq 升序排好）线性折叠进 state，返回新对象；
 * 不修改 state 与 updates。
 *
 * - 有 reducer 的 key：`next[key] = reducer(next[key], update.value)`；reducer 抛出的任何错误
 *   统一包装为 `InvalidWriteError`（`writers: [writer]`，原错误放入 `cause`，消息包含原消息）。
 * - 无 reducer 的 key：单个写入直接取值（last-value 覆盖）；同一 fold 内 2+ 次写入 →
 *   `InvalidWriteError`，`writers` 为按 updates 顺序的全部写入者。为拿到完整写入者列表，
 *   该错误在扫描完整个数组后才抛出；reducer 错误则在其被触发的写入处立即抛出。
 */
export function foldUpdates<S extends object>(
	state: S,
	updates: ChannelUpdate[],
	channels: StateSchema<S>,
): S {
	const next = { ...state } as S & Record<string, unknown>;
	const reducers = channels as Partial<Record<string, Reducer<unknown>>>;
	const reducerlessWriters = new Map<string, string[]>();
	// TS2862：泛型交集只允许读取式索引，写入走这个非泛型别名。
	const mutable: Record<string, unknown> = next;

	for (const { key, value, writer } of updates) {
		// 用 hasOwn 而非原型链查找：key 恰好叫 "constructor" / "toString" 时
		// 不能被 Object.prototype 上的成员误当成 reducer。
		const reducer = Object.hasOwn(reducers, key) ? reducers[key] : undefined;
		if (reducer === undefined) {
			const writers = reducerlessWriters.get(key);
			if (writers === undefined) {
				reducerlessWriters.set(key, [writer]);
				mutable[key] = value;
			} else {
				writers.push(writer);
			}
			continue;
		}

		let folded: unknown;
		try {
			folded = reducer(mutable[key], value);
		} catch (cause) {
			const error = new InvalidWriteError(
				`invalid write to channel "${key}" by "${writer}": ${messageOf(cause)}`,
				{ key, writers: [writer] },
			);
			error.cause = cause;
			throw error;
		}
		mutable[key] = folded;
	}

	for (const [key, writers] of reducerlessWriters) {
		if (writers.length > 1) {
			throw new InvalidWriteError(
				`conflicting writes to channel "${key}" in the same fold (writers: ${writers.join(", ")})`,
				{ key, writers },
			);
		}
	}

	return next;
}

/**
 * 已知的 State key 宇宙：`stateSchema` 的可枚举 `properties` keys（typebox 对象
 * schema）。compile 期的 writeTo 校验（§6.5/R14）与 run 期的"节点返回未知 key"
 * 校验（§6.7/T10）共用这一判定——两处必须语义一致，故只有这一份实现。
 *
 * 无法枚举时（未提供 / 非对象 / 没有 properties）→ `undefined` = 宇宙未知 →
 * 调用方跳过校验：宁可漏报，绝不误报。`channels` 永不作宇宙（`StateSchema<S>` 是
 * Partial 映射，只列有 reducer 的 key，无 reducer 的 key 合法可写）。
 */
export function stateKeyUniverse(
	schema: TSchema | undefined,
): Set<string> | undefined {
	if (!isRecord(schema)) {
		return undefined;
	}
	const properties = schema.properties;
	return isRecord(properties) ? new Set(Object.keys(properties)) : undefined;
}

/** 非 null、非数组的对象（识别 typebox object schema 的 `properties`）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 错误消息里对任意值的简短描述：不展开对象，避免循环引用与超长输出。 */
function describeValue(value: unknown): string {
	if (Array.isArray(value)) {
		return `array(${value.length})`;
	}
	if (value === null) {
		return "null";
	}
	switch (typeof value) {
		case "string":
			return `string(${JSON.stringify(value)})`;
		case "undefined":
			return "undefined";
		case "object":
		case "function":
			return typeof value;
		default:
			return `${typeof value}(${String(value)})`;
	}
}

/** 取任意 thrown 值的消息文本（reducer 允许抛非 Error 值）。 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
