import { describe, expect, test } from "bun:test";
import { HealthService } from "../src/health/health.service";

describe("HealthService", () => {
	test("live retorna status ok", () => {
		expect(new HealthService().live()).toEqual({ status: "ok" });
	});
});
