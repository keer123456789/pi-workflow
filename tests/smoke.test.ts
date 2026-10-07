import { Type as T } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

describe("scaffold", () => {
	it("vitest runs", () => {
		expect(1 + 1).toBe(2);
	});
	it("typebox Value.Check validates", () => {
		const Schema = T.Object({ name: T.String() });
		expect(Value.Check(Schema, { name: "x" })).toBe(true);
		expect(Value.Check(Schema, {})).toBe(false);
	});
});
