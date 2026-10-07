/**
 * 重试分类（设计 §7.2 落地、D3，Task 5）：判定一次失败是"可重试"（瞬态）还是
 * "不可重试"（立即失败——不退避、不发 node_retry）。
 *
 * 判定顺序（D3）：
 * 1. **内部标记**：`markRetryable()` 打的非枚举 Symbol——llm 节点的 schema/JSON 失败用它
 *    （Task 6）；标记不进 JSON、不进枚举、日志与事件载荷都看不到；
 * 2. **`error.code === "ECONNRESET"`**：Node 网络错误的机器可读形态（消息里不带
 *    "ECONNRESET" 也命中）；
 * 3. **消息正则族**（对抛值渲染出的文本求匹配）：
 *    `/(?:^|\D)(?:429|408|5\d\d)(?:\D|$)|rate[ -]?limit|too many requests|timeout|timed out|ECONNRESET|socket hang ?up/i`
 *    ——数字状态码要求**两侧非数字**（"1408" 不因粘连命中 "408"）。
 *
 * 其余口径：
 * - 非 Error 抛值（handler 允许抛任意值）按引擎渲染口径取文本——对象先 `JSON.stringify`
 *   （`throw { code: 429 }` 的可见消息就是 `{"code":429}`），失败回落 `String()`；渲染路径
 *   自身故障（极端抛值连 `String()` 都抛）→ 分类保守判"不可重试"，**分类绝不抛**（引擎的
 *   失败分支不允许被分类拖崩）；
 * - 引擎自身 attempt 超时消息含 "timed out" → 天然可重试（§7.3 超时 = 可重试失败）；
 * - 纯函数、零 I/O、零依赖；`retry.maxAttempts` 仍是总尝试次数上限（本模块只回答
 *   "这个错误值不值得重试"）。
 *
 * 本模块为**内部**模块：不进 `src/index.ts` 公开面（M2 只新增 llmNode 与三个类型）。
 */

/** 可重试标记的键：Symbol + 非枚举——`Object.keys` / `JSON.stringify` / 日志都看不到它。 */
const RETRYABLE = Symbol("pi-workflow.retryable");

/** D3 的消息正则族（逐字，勿改）。 */
const RETRYABLE_MESSAGE =
	/(?:^|\D)(?:429|408|5\d\d)(?:\D|$)|rate[ -]?limit|too many requests|timeout|timed out|ECONNRESET|socket hang ?up/i;

/** D3 的机器可读错误码（严格等值，大小写敏感——与 Node 的 ECONNRESET 一致）。 */
const RETRYABLE_CODE = "ECONNRESET";

/**
 * 把错误标成"可重试"（D3）：非枚举 Symbol 属性，原样返回**同一实例**（可内联
 * `throw markRetryable(new Error(...))`）。同一实例重复标记幂等。
 */
export function markRetryable<T extends Error>(error: T): T {
	Object.defineProperty(error, RETRYABLE, {
		value: true,
		enumerable: false,
		configurable: true,
		writable: false,
	});
	return error;
}

/**
 * 重试分类（D3）：标记命中 → true；否则 `code === "ECONNRESET"` → true；否则消息文本
 * 命中正则族。**永不抛**（见模块注释）。
 */
export function isRetryableError(error: unknown): boolean {
	if (
		(typeof error === "object" && error !== null) ||
		typeof error === "function"
	) {
		const record = error as Record<PropertyKey, unknown>;
		if (record[RETRYABLE] === true) {
			return true;
		}
		if (record.code === RETRYABLE_CODE) {
			return true;
		}
	}
	try {
		return RETRYABLE_MESSAGE.test(messageTextOf(error));
	} catch {
		// 极端抛值（null 原型 + 抛错的 toString/valueOf）：没有可读文本可用——
		// 按"不可重试"保守处理；分类本身绝不让引擎的失败分支崩掉。
		return false;
	}
}

/**
 * 任意 thrown 值的消息文本（与引擎 `messageOf` 同口径）：Error → message；其他对象先试
 * `JSON.stringify`（`throw { code: 429 }` 不该被漏判）；序列化失败或产出 `undefined`
 * 回落 `String()`——这条路径可能抛（极端抛值），由 {@link isRetryableError} 兜住。
 */
function messageTextOf(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "object" && error !== null) {
		try {
			const json = JSON.stringify(error);
			if (json !== undefined) {
				return json;
			}
		} catch {
			// 循环引用 / BigInt / 抛错的 toJSON：回落 String() 渲染
		}
	}
	return String(error);
}
