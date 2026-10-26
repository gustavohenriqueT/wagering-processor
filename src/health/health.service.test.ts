import { describe, expect, test } from "bun:test";
import { HealthService } from "./health.service";

describe("HealthService", () => {
	test("live retorna status ok", () => {
		expect(new HealthService().live()).toEqual({ status: "ok" });
	});
});
