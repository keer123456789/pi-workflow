import { describe, expect, it } from "vitest";

import { InvalidWriteError } from "../../src/core/errors.js";
import {
	append,
	concat,
	foldUpdates,
	overwrite,
	type Reducer,
	setOnce,
} from "../../src/core/state.js";

/** 以 unknown 入参调用 reducer，模拟运行期收到与类型声明不符的值。 */
function callLoose<V>(
	reducer: Reducer<V>,
	current: unknown,
	update: unknown,
): unknown {
	return reducer(current as V, update as V);
}

/** 捕获 fn 抛出的值；若未抛出则让测试失败。 */
function captureThrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (thrown) {
		return thrown;
	}
	throw new Error("expected the function to throw, but it returned normally");
}

/** 断言 fn 抛出 InvalidWriteError 并返回它，便于继续断言字段。 */
function captureInvalidWriteError(fn: () => unknown): InvalidWriteError {
	const thrown = captureThrown(fn);
	expect(thrown).toBeInstanceOf(InvalidWriteError);
	return thrown as InvalidWriteError;
}

describe("overwrite", () => {
	it("returns the latest write", () => {
		expect(overwrite("current", "update")).toBe("update");
	});

	it("lets the last writer win in fold order", () => {
		const out = foldUpdates(
			{ value: "seed" },
			[
				{ key: "value", value: "first", writer: "n1" },
				{ key: "value", value: "second", writer: "n2" },
			],
			{ value: overwrite },
		);

		expect(out.value).toBe("second");
	});

	it("overwrites with anything, including null and undefined", () => {
		const withNull = foldUpdates(
			{ value: "seed" },
			[{ key: "value", value: null, writer: "n1" }],
			{ value: overwrite },
		);
		expect(withNull.value).toBeNull();

		const withUndefined = foldUpdates(
			{ value: "seed" },
			[{ key: "value", value: undefined, writer: "n1" }],
			{ value: overwrite },
		);
		expect(withUndefined.value).toBeUndefined();
		expect(Object.hasOwn(withUndefined, "value")).toBe(true);
	});
});

describe("append", () => {
	it("concatenates into a new array and leaves both sides untouched", () => {
		const current = [1, 2];
		const update = [3];

		expect(append(current, update)).toEqual([1, 2, 3]);
		expect(current).toEqual([1, 2]);
		expect(update).toEqual([3]);
	});

	it("throws a plain Error (not InvalidWriteError) when the current side is not an array", () => {
		const thrown = captureThrown(() => callLoose(append, undefined, []));

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(InvalidWriteError);
		expect((thrown as Error).message).toMatch(/append: expected arrays/);
	});

	it("throws a plain Error (not InvalidWriteError) when the update side is not an array", () => {
		const thrown = captureThrown(() => callLoose(append, [], "nope"));

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(InvalidWriteError);
		expect((thrown as Error).message).toMatch(/append: expected arrays/);
	});
});

describe("concat", () => {
	it("concatenates strings in fold order", () => {
		expect(concat("a", "b")).toBe("ab");

		const out = foldUpdates(
			{ title: "" },
			[
				{ key: "title", value: "Hello", writer: "n1" },
				{ key: "title", value: " world", writer: "n2" },
			],
			{ title: concat },
		);

		expect(out.title).toBe("Hello world");
	});
});

describe("setOnce", () => {
	it("accepts the first write", () => {
		expect(setOnce(undefined, "result")).toBe("result");
	});

	it("throws a plain Error (not InvalidWriteError) on a second write; null counts as written", () => {
		const thrown = captureThrown(() => setOnce("first", "second"));

		expect(thrown).toBeInstanceOf(Error);
		expect(thrown).not.toBeInstanceOf(InvalidWriteError);
		expect((thrown as Error).message).toMatch(/setOnce/);
		expect(() => setOnce(null, "second")).toThrow(Error);
	});

	it("wraps a second write through foldUpdates as InvalidWriteError with the writer", () => {
		const first = foldUpdates<{ final?: string }>(
			{},
			[{ key: "final", value: "r1", writer: "n1" }],
			{ final: setOnce },
		);
		expect(first.final).toBe("r1");

		const thrown = captureInvalidWriteError(() =>
			foldUpdates(
				{ final: "r1" },
				[{ key: "final", value: "r2", writer: "n2" }],
				{ final: setOnce },
			),
		);

		expect(thrown.key).toBe("final");
		expect(thrown.writers).toEqual(["n2"]);
		expect(thrown.cause).toBeInstanceOf(Error);
		expect(thrown.message).toContain("setOnce");
	});
});

describe("foldUpdates", () => {
	it("folds updates in given order with reducer", () => {
		const out = foldUpdates(
			{ logs: [] as string[] },
			[
				{ key: "logs", value: ["a"], writer: "n1" },
				{ key: "logs", value: ["b"], writer: "n2" },
			],
			{ logs: append },
		);

		expect(out.logs).toEqual(["a", "b"]);
	});

	it("is order-sensitive: reversed updates fold in the reversed order", () => {
		const out = foldUpdates(
			{ logs: [] as string[] },
			[
				{ key: "logs", value: ["b"], writer: "n2" },
				{ key: "logs", value: ["a"], writer: "n1" },
			],
			{ logs: append },
		);

		expect(out.logs).toEqual(["b", "a"]);
	});

	it("throws InvalidWriteError listing both writers on reducer-less key", () => {
		const fold = () =>
			foldUpdates(
				{},
				[
					{ key: "x", value: 1, writer: "n1" },
					{ key: "x", value: 2, writer: "n2" },
				],
				{},
			);

		expect(fold).toThrow(InvalidWriteError);

		const thrown = captureInvalidWriteError(fold);
		expect(thrown.key).toBe("x");
		expect(thrown.writers).toEqual(["n1", "n2"]);
		expect(thrown.message).toContain("x");
	});

	it("lists every writer of a conflicted reducer-less key in updates order", () => {
		const thrown = captureInvalidWriteError(() =>
			foldUpdates(
				{},
				[
					{ key: "x", value: 1, writer: "n1" },
					{ key: "x", value: 2, writer: "n2" },
					{ key: "x", value: 3, writer: "n3" },
				],
				{},
			),
		);

		expect(thrown.key).toBe("x");
		expect(thrown.writers).toEqual(["n1", "n2", "n3"]);
	});

	it("takes the single value for a reducer-less key, overwriting the previous state value", () => {
		const out = foldUpdates(
			{ x: "old" },
			[{ key: "x", value: "new", writer: "n1" }],
			{},
		);

		expect(out.x).toBe("new");
	});

	it("folds multiple keys with mixed reducers in one pass", () => {
		const out = foldUpdates(
			{ logs: ["seed"], title: "" },
			[
				{ key: "logs", value: ["a"], writer: "n1" },
				{ key: "title", value: "hello", writer: "n2" },
				{ key: "logs", value: ["b"], writer: "n3" },
			],
			{ logs: append, title: concat },
		);

		expect(out).toEqual({ logs: ["seed", "a", "b"], title: "hello" });
	});

	it("wraps reducer-thrown errors as InvalidWriteError with key, writer and cause", () => {
		const boom = new Error("custom reducer exploded");
		const exploding: Reducer<number> = () => {
			throw boom;
		};

		const thrown = captureInvalidWriteError(() =>
			foldUpdates({ n: 0 }, [{ key: "n", value: 1, writer: "n1" }], {
				n: exploding,
			}),
		);

		expect(thrown.key).toBe("n");
		expect(thrown.writers).toEqual(["n1"]);
		expect(thrown.cause).toBe(boom);
		expect(thrown.message).toContain(boom.message);
	});

	it("wraps non-Error reducer throws, preserving the thrown value as cause", () => {
		const reason = "reducer said no";
		const refusing: Reducer<number> = () => {
			throw reason;
		};

		const thrown = captureInvalidWriteError(() =>
			foldUpdates({ n: 0 }, [{ key: "n", value: 1, writer: "n1" }], {
				n: refusing,
			}),
		);

		expect(thrown.cause).toBe(reason);
		expect(thrown.message).toContain(reason);
	});

	it("wraps append rejection when the current side is not an array", () => {
		// 类型声明说是数组，运行期状态却不是（未初始化 / 上游写坏）。
		const state = { logs: undefined } as unknown as { logs: unknown[] };

		const thrown = captureInvalidWriteError(() =>
			foldUpdates(state, [{ key: "logs", value: ["a"], writer: "n1" }], {
				logs: append,
			}),
		);

		expect(thrown.key).toBe("logs");
		expect(thrown.writers).toEqual(["n1"]);
		expect(thrown.cause).toBeInstanceOf(Error);
		expect(thrown.cause).not.toBeInstanceOf(InvalidWriteError);
		expect((thrown.cause as Error).message).toMatch(/append: expected arrays/);
		expect(thrown.message).toContain((thrown.cause as Error).message);
	});

	it("wraps append rejection when the update side is not an array (undefined)", () => {
		const thrown = captureInvalidWriteError(() =>
			foldUpdates(
				{ logs: [] as string[] },
				[{ key: "logs", value: undefined, writer: "n1" }],
				{ logs: append },
			),
		);

		expect(thrown.key).toBe("logs");
		expect(thrown.writers).toEqual(["n1"]);
		expect(thrown.cause).toBeInstanceOf(Error);
		expect(thrown.cause).not.toBeInstanceOf(InvalidWriteError);
		expect((thrown.cause as Error).message).toMatch(/append: expected arrays/);
		expect(thrown.message).toContain((thrown.cause as Error).message);
	});

	it("returns a new object and does not mutate the input state or the updates array", () => {
		const state = { logs: ["seed"], count: 0 };
		const updates = [
			{ key: "logs", value: ["a"], writer: "n1" },
			{ key: "count", value: 1, writer: "n2" },
		];
		const expectedState = { logs: ["seed"], count: 0 };
		const expectedUpdates = [
			{ key: "logs", value: ["a"], writer: "n1" },
			{ key: "count", value: 1, writer: "n2" },
		];

		const out = foldUpdates(state, updates, { logs: append });

		expect(out).not.toBe(state);
		expect(out).toEqual({ logs: ["seed", "a"], count: 1 });
		expect(state).toEqual(expectedState);
		expect(updates).toEqual(expectedUpdates);
	});

	it("returns a fresh copy for an empty updates array", () => {
		const state = { logs: ["seed"] };

		const out = foldUpdates(state, [], { logs: append });

		expect(out).not.toBe(state);
		expect(out).toEqual({ logs: ["seed"] });
	});

	it("does not mistake Object.prototype members for reducers on reducer-less keys", () => {
		const out = foldUpdates(
			{},
			[{ key: "constructor", value: "value", writer: "n1" }],
			{},
		);
		expect(out).toEqual({ constructor: "value" });

		const thrown = captureInvalidWriteError(() =>
			foldUpdates(
				{},
				[
					{ key: "toString", value: 1, writer: "n1" },
					{ key: "toString", value: 2, writer: "n2" },
				],
				{},
			),
		);

		expect(thrown.key).toBe("toString");
		expect(thrown.writers).toEqual(["n1", "n2"]);
	});

	it('rejects the "__proto__" key before any write (prototype pollution guard, R24)', () => {
		// mutable["__proto__"] = value 走原型 setter：对象值 → 改 state 原型（污染），
		// 非对象值 → 静默丢弃。写入侧立即抛 InvalidWriteError。
		const thrown = captureInvalidWriteError(() =>
			foldUpdates({}, [{ key: "__proto__", value: { x: 1 }, writer: "n" }], {}),
		);

		expect(thrown.message).toContain('channel key "__proto__" is forbidden');
		expect(thrown.key).toBe("__proto__");
		expect(thrown.writers).toEqual(["n"]);
	});
});
