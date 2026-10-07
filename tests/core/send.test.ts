import { describe, expect, it } from "vitest";

import { Send } from "../../src/core/send.js";

describe("Send", () => {
	it("exposes node and input", () => {
		const input = { docId: "doc-1" };
		const send = new Send("review", input);

		expect(send.node).toBe("review");
		expect(send.input).toBe(input);
	});

	it("keeps the input reference as-is (it becomes the instance input, no copy)", () => {
		const input = ["a", "b"];
		const send = new Send("review", input);

		expect(send.input).toBe(input);
	});

	it("defaults the input generic to unknown (Send works inside RouterResult)", () => {
		const send: Send = new Send("review", { anything: true });

		expect(send.node).toBe("review");
		expect(send.input).toEqual({ anything: true });
	});

	it("is an instance of Send (routers are distinguished by instanceof)", () => {
		expect(new Send("a", 1)).toBeInstanceOf(Send);
	});
});
