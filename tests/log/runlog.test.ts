/**
 * Task 2：JSONL 运行日志实现（设计 §8、D6/D8/D9）。
 *
 * 契约：
 * - 路径布局（D9）：`<dir>/<YYYYMMDDTHHmmssSSSZ>-<runId>/run.jsonl`，时间戳取工厂的
 *   `ts`（ms 时钟值）格式化为 UTC、无冒号无点（Windows 合法文件名）；
 * - 每行一个 JSON 事件 + `\n`；同步 append ⇒ 文件行序 = 钩子调用序；
 * - `onRunStart` 建目录 + 建空文件（失败即刻抛）；`onRunFinish` 无状态、no-op；
 * - 任何 fs 错误包装为 `Error("run log write failed: <原因.message>", { cause })`，
 *   onRunStart 与 onEvent 两条路径都包（引擎 Task 3 据 onLogError 决策 fail/warn）。
 *
 * 夹具全部落在 `os.tmpdir()` 下并在 afterEach 递归清理：不进仓库工作树。
 */

import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunEvent } from "../../src/core/types.js";
import { createJsonlLogger, formatLogTimestamp } from "../../src/log/runlog.js";

/** 本次用例创建的临时根目录（afterEach 统一递归删除）。 */
let tempRoots: string[] = [];

function makeTempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-workflow-log-"));
	tempRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true });
	}
	tempRoots = [];
});

/** 取钩子抛出的错误本体（断言包装字段用）。 */
function captureThrow(fn: () => void): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("createJsonlLogger (D6/D8/D9)", () => {
	it("creates <dir>/<YYYYMMDDTHHmmssSSSZ>-<runId>/run.jsonl and appends one JSON event per line", () => {
		const tmp = makeTempRoot();
		const logger = createJsonlLogger({
			dir: tmp,
			runId: "r1",
			ts: Date.UTC(2026, 9, 7, 12, 0, 0, 123),
		});

		const started: RunEvent = {
			seq: 1,
			superstep: 0,
			ts: 1,
			runId: "r1",
			type: "run_started",
			graph: "g",
			input: { question: "42?" },
		};
		const finished: RunEvent = {
			seq: 2,
			superstep: 1,
			ts: 2,
			runId: "r1",
			type: "run_finished",
			status: "completed",
			durationMs: 7,
		};

		logger.onRunStart?.({ runId: "r1", graph: "g", ts: 1 });

		// 目录名 = 工厂入参 ts 的 UTC 格式化 + runId（非 Date.now()、非本地时区）
		expect(readdirSync(tmp)).toEqual(["20261007T120000123Z-r1"]);
		const filePath = join(tmp, "20261007T120000123Z-r1", "run.jsonl");
		// onRunStart 就建出空文件：目录不可写必须在这里抛，不能推迟到首个事件
		expect(existsSync(filePath)).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("");

		logger.onEvent?.(started);
		logger.onEvent?.(finished);
		const beforeFinish = readFileSync(filePath, "utf8");

		logger.onRunFinish?.({ runId: "r1", status: "completed", ts: 3 });

		// 两行事件、行尾 \n（含末行），onRunFinish 不追加任何内容（无状态 no-op）
		expect(readFileSync(filePath, "utf8")).toBe(beforeFinish);
		expect(beforeFinish).toBe(
			`${JSON.stringify(started)}\n${JSON.stringify(finished)}\n`,
		);
		const lines = beforeFinish.split("\n");
		expect(lines.at(-1)).toBe("");
		expect(lines.slice(0, -1).map((line) => JSON.parse(line))).toEqual([
			started,
			finished,
		]);
	});

	it("throws a wrapped error (message includes the path) when the directory cannot be created", () => {
		const tmp = makeTempRoot();
		// dir 指向一个已存在的**文件**：递归 mkdir 必然失败
		const blocked = join(tmp, "blocked");
		writeFileSync(blocked, "occupied");
		const logger = createJsonlLogger({ dir: blocked, runId: "r1", ts: 0 });

		const caught = captureThrow(() =>
			logger.onRunStart?.({ runId: "r1", graph: "g", ts: 0 }),
		);

		expect(caught).toBeInstanceOf(Error);
		const wrapped = caught as Error & { cause?: unknown };
		expect(wrapped.message).toMatch(/^run log write failed: /);
		expect(wrapped.message).toContain(blocked);
		expect(wrapped.cause).toBeInstanceOf(Error);
		// 包装消息原样嵌入 cause.message（不吞原因、不换错误类型）
		expect(wrapped.message).toBe(
			`run log write failed: ${(wrapped.cause as Error).message}`,
		);
	});

	it("wraps fs errors from onEvent too (write failure after a successful start)", () => {
		const tmp = makeTempRoot();
		const logger = createJsonlLogger({ dir: tmp, runId: "r1", ts: 0 });
		logger.onRunStart?.({ runId: "r1", graph: "g", ts: 0 });
		rmSync(join(tmp, "19700101T000000000Z-r1"), {
			recursive: true,
			force: true,
		});

		const caught = captureThrow(() =>
			logger.onEvent?.({
				seq: 1,
				superstep: 0,
				ts: 0,
				runId: "r1",
				type: "superstep_committed",
			}),
		);

		expect(caught).toBeInstanceOf(Error);
		const wrapped = caught as Error & { cause?: unknown };
		expect(wrapped.message).toMatch(/^run log write failed: /);
		expect(wrapped.message).toContain("run.jsonl");
		expect(wrapped.cause).toBeInstanceOf(Error);
		expect(wrapped.message).toBe(
			`run log write failed: ${(wrapped.cause as Error).message}`,
		);
	});
});

describe("formatLogTimestamp (D9)", () => {
	it("formats the ms clock value as UTC YYYYMMDDTHHmmssSSSZ", () => {
		expect(formatLogTimestamp(Date.UTC(2026, 9, 7, 12, 0, 0, 123))).toBe(
			"20261007T120000123Z",
		);
		// 补零下界：1 月 1 日 0 时 0 分 0 秒 0 毫秒
		expect(formatLogTimestamp(Date.UTC(2026, 0, 1, 0, 0, 0, 0))).toBe(
			"20260101T000000000Z",
		);
		// 毫秒补足三位；12 月 31 日 23:59:59
		expect(formatLogTimestamp(Date.UTC(2026, 11, 31, 23, 59, 59, 7))).toBe(
			"20261231T235959007Z",
		);
	});
});
