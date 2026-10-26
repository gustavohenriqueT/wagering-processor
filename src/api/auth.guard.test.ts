import { describe, expect, test } from "bun:test";
import { AuthGuard } from "./auth.guard";

describe("AuthGuard (ponto de extensão)", () => {
	test("é um no-op: autoriza qualquer requisição até que um IdP seja integrado", () => {
		expect(new AuthGuard().canActivate()).toBe(true);
	});
});
