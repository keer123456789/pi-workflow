/**
 * M4/T1：共享对等依赖探测（probePeerPackage）的单测——两步机制自 llm-pi-ai.ts
 * 逐字平移到 `src/runtime/peer-resolve.ts`，行为逐字不变（pi-ai 与 M4 的
 * pi-coding-agent 共用，D28）。
 *
 * mock `node:module` 的 createRequire 覆盖两分支：直通（真包在 devDependencies →
 * true）与失败（复现 pi-ai exports map 无 `"require"` 条件时 require.resolve 的
 * ERR_PACKAGE_PATH_NOT_EXPORTED——正是必须退 `import.meta.resolve` 的缘由）；
 * 另钉"永不抛"：探测失败一律 false。
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { probePeerPackage } from "../../src/runtime/peer-resolve.js";

/** 假 createRequire（vi.hoisted：mock 工厂与用例共享同一替身）。 */
const mocks = vi.hoisted(() => {
	const createRequire = vi.fn<(filename: string | URL) => NodeJS.Require>();
	return { createRequire };
});

vi.mock("node:module", () => ({ createRequire: mocks.createRequire }));

/** 真实 createRequire（beforeAll 经 importActual 取回，给直通分支用）。 */
let realCreateRequire: typeof import("node:module").createRequire;

beforeAll(async () => {
	({ createRequire: realCreateRequire } =
		await vi.importActual<typeof import("node:module")>("node:module"));
});

beforeEach(() => {
	vi.clearAllMocks();
	// 缺省直通：mock 的行为与真实 createRequire 一致（用例再按需改写）。
	mocks.createRequire.mockImplementation((filename) =>
		realCreateRequire(filename),
	);
});

describe("probePeerPackage (M4/T1 平移)", () => {
	it("resolves a real devDependency through createRequire, passing the module's own URL", () => {
		// 真包在 devDependencies（本仓库）→ true；探测机制本身（import.meta.url 来源）
		// 与参数透传一起钉住。
		expect(probePeerPackage("@earendil-works/pi-ai")).toBe(true);
		expect(mocks.createRequire).toHaveBeenCalledTimes(1);
		expect(String(mocks.createRequire.mock.calls[0][0])).toContain(
			"peer-resolve",
		);
		expect(String(mocks.createRequire.mock.calls[0][0])).toMatch(
			/^file:\/\/\//,
		);
	});

	it("falls back to import.meta.resolve when require.resolve fails (pi-ai 的 exports map 无 require 条件)", () => {
		// 复现 M0 实测形态：require.resolve 按 CJS 条件解析必然
		// ERR_PACKAGE_PATH_NOT_EXPORTED——探测必须退到 ESM 条件才报 true。
		mocks.createRequire.mockImplementation(() => {
			const error = new Error(
				"Package exports for '.' do not define a 'require' condition",
			) as Error & { code?: string };
			error.code = "ERR_PACKAGE_PATH_NOT_EXPORTED";
			throw error;
		});

		expect(probePeerPackage("@earendil-works/pi-ai")).toBe(true);
	});

	it("returns false (never throws) for a package that cannot be resolved at all", () => {
		// createRequire 直通到真实 require：乱包名在两步里都解析不到 → false，
		// 且结果稳定（探测无副作用、永不抛）。
		expect(probePeerPackage("@earendil-works/definitely-not-installed")).toBe(
			false,
		);
		expect(probePeerPackage("@earendil-works/definitely-not-installed")).toBe(
			false,
		);
	});

	it("never throws even when createRequire itself fails before resolving", () => {
		mocks.createRequire.mockImplementation(() => {
			throw new Error("simulated broken require");
		});

		// 兜底路径同样收口为 false，绝不抛——"探测失败 = false"是 D13/D28 的契约。
		expect(probePeerPackage("@earendil-works/definitely-not-installed")).toBe(
			false,
		);
		expect(probePeerPackage("@earendil-works/pi-ai")).toBe(true);
	});
});
