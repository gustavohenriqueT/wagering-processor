import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SRC = import.meta.dir;

const ALLOWED: Record<string, string[]> = {
	domain: [],
	application: ["domain", "observability"],
	infrastructure: ["application", "domain", "observability", "config"],
	messaging: ["application", "domain", "observability", "tokens"],
	api: ["application", "domain", "observability", "messaging", "tokens"],
	observability: [],
};

function filesOf(directory: string): string[] {
	return readdirSync(directory).flatMap((entry) => {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			return filesOf(path);
		}
		return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
	});
}

function layerOf(path: string): string | undefined {
	const [first] = relative(SRC, path).split(sep);
	if (first === undefined) {
		return undefined;
	}
	return first.endsWith(".ts") ? first.replace(/\.ts$/, "") : first;
}

function relativeImports(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const targets: string[] = [];
	for (const match of source.matchAll(
		/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g,
	)) {
		const specifier = match[1];
		if (specifier !== undefined) {
			targets.push(resolve(dirname(file), specifier));
		}
	}
	return targets;
}

describe("arquitetura em camadas", () => {
	for (const [layer, allowed] of Object.entries(ALLOWED)) {
		test(`${layer} só depende de: ${[layer, ...allowed].join(", ")}`, () => {
			const violations: string[] = [];
			for (const file of filesOf(join(SRC, layer))) {
				for (const target of relativeImports(file)) {
					const targetLayer = layerOf(target);
					if (
						targetLayer !== undefined &&
						targetLayer !== layer &&
						!allowed.includes(targetLayer)
					) {
						violations.push(
							`${relative(SRC, file)} importa de ${targetLayer} (${relative(SRC, target)})`,
						);
					}
				}
			}
			expect(violations).toEqual([]);
		});
	}

	test("o domínio não importa nenhum framework nem biblioteca de infraestrutura", () => {
		const forbidden = /from\s+['"](@nestjs|@mikro-orm|@aws-sdk|express|pg)/;
		const offenders = filesOf(join(SRC, "domain")).filter((file) =>
			forbidden.test(readFileSync(file, "utf8")),
		);
		expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
	});

	test("a aplicação não importa framework web nem driver de banco/fila (só as portas)", () => {
		const forbidden = /from\s+['"](@nestjs|@mikro-orm|@aws-sdk|express|pg)/;
		const offenders = filesOf(join(SRC, "application")).filter((file) =>
			forbidden.test(readFileSync(file, "utf8")),
		);
		expect(offenders.map((file) => relative(SRC, file))).toEqual([]);
	});
});
