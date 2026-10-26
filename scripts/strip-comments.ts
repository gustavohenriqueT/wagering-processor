import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIRECTORIES = ["src", "test", "scripts"];
const KEEP_DIRECTIVE =
	/^(\/\/\/\s*<|\/\/\s*@ts-|\/\/\s*(eslint|biome|prettier)|\/\*!)/;
const REGEX_PRECEDERS = new Set([
	"",
	"(",
	",",
	"=",
	":",
	"[",
	"!",
	"&",
	"|",
	"?",
	"{",
	"}",
	";",
	"+",
	"-",
	"*",
	"%",
	"<",
	">",
	"~",
	"^",
]);
const REGEX_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);
const WORD = /[\p{L}\p{N}_$]/u;

export function stripComments(
	source: string,
	keepJsDoc: boolean,
): { code: string; removed: number } {
	const src = source;
	const n = src.length;
	const eol = src.includes("\r\n") ? "\r\n" : "\n";
	let out = "";
	let i = 0;
	let removed = 0;
	let prev = "";
	let depth = 0;
	const expressionStack: number[] = [];

	const lineIsBlank = (from: number): boolean => {
		const end = src.indexOf("\n", from);
		return src.slice(from, end === -1 ? n : end).trim() === "";
	};

	/** Depois de apagar uma linha de comentário, não deixa linhas em branco duplicadas. */
	const collapseBlankLines = (): void => {
		const previousIsBlank = out === "" || /(^|\n)[ \t]*\r?\n$/.test(out);
		if (!previousIsBlank) {
			return;
		}
		while (i < n && lineIsBlank(i)) {
			const end = src.indexOf("\n", i);
			if (end === -1) {
				i = n;
				break;
			}
			i = end + 1;
		}
	};

	/** Copia o texto de um template literal até o fechamento ou até o próximo `${`. */
	const copyTemplateText = (): void => {
		while (i < n) {
			const c = src[i] as string;
			if (c === "\\") {
				out += src.slice(i, i + 2);
				i += 2;
			} else if (c === "`") {
				out += c;
				i += 1;
				prev = "`";
				return;
			} else if (c === "$" && src[i + 1] === "{") {
				out += "${";
				i += 2;
				expressionStack.push(depth);
				depth = 0;
				prev = "{";
				return;
			} else {
				out += c;
				i += 1;
			}
		}
	};

	while (i < n) {
		const c = src[i] as string;
		const next = src[i + 1];

		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < n && src[j] !== c && src[j] !== "\n") {
				j += src[j] === "\\" ? 2 : 1;
			}
			out += src.slice(i, Math.min(j + 1, n));
			i = j + 1;
			prev = '"';
			continue;
		}

		if (c === "`") {
			out += c;
			i += 1;
			copyTemplateText();
			continue;
		}

		if (c === "/" && next === "/") {
			const lineEnd = src.indexOf("\n", i);
			const end = lineEnd === -1 ? n : lineEnd;
			const commentEnd = src[end - 1] === "\r" ? end - 1 : end;
			const text = src.slice(i, commentEnd);
			if (KEEP_DIRECTIVE.test(text)) {
				out += text;
				i = commentEnd;
				continue;
			}
			removed += 1;
			const lineStart = out.lastIndexOf("\n") + 1;
			if (out.slice(lineStart).trim() === "") {
				out = out.slice(0, lineStart);
				i = lineEnd === -1 ? n : lineEnd + 1;
				collapseBlankLines();
			} else {
				out = out.replace(/[ \t]+$/, "");
				i = commentEnd;
			}
			continue;
		}

		if (c === "/" && next === "*") {
			const close = src.indexOf("*/", i + 2);
			const end = close === -1 ? n : close + 2;
			const text = src.slice(i, end);
			const isJsDoc = text.startsWith("/**") && text !== "/**/";
			if (KEEP_DIRECTIVE.test(text) || (keepJsDoc && isJsDoc)) {
				out += text;
				i = end;
				continue;
			}
			removed += 1;
			const lineStart = out.lastIndexOf("\n") + 1;
			const lineEnd = src.indexOf("\n", end);
			const restOfLine = src.slice(end, lineEnd === -1 ? n : lineEnd).trim();
			if (out.slice(lineStart).trim() === "" && restOfLine === "") {
				out = out.slice(0, lineStart);
				i = lineEnd === -1 ? n : lineEnd + 1;
				collapseBlankLines();
			} else {
				i = end;
				if (restOfLine === "") {
					out = out.replace(/[ \t]+$/, "");
				} else {
					while (src[i] === " " && out.endsWith(" ")) {
						i += 1;
					}
				}
			}
			continue;
		}

		if (c === "/") {
			const regexAllowed =
				REGEX_PRECEDERS.has(prev) || REGEX_KEYWORDS.has(prev);
			if (regexAllowed) {
				let j = i + 1;
				let inClass = false;
				while (j < n) {
					const d = src[j] as string;
					if (d === "\\") {
						j += 2;
						continue;
					}
					if (d === "\n") {
						break;
					}
					if (d === "[") {
						inClass = true;
					} else if (d === "]") {
						inClass = false;
					} else if (d === "/" && !inClass) {
						break;
					}
					j += 1;
				}
				if (src[j] === "/") {
					j += 1;
					while (j < n && /[a-z]/i.test(src[j] as string)) {
						j += 1;
					}
					out += src.slice(i, j);
					i = j;
					prev = "/re/";
					continue;
				}
			}
			out += c;
			i += 1;
			prev = "/";
			continue;
		}

		if (c === "{") {
			depth += 1;
		} else if (c === "}") {
			if (depth === 0 && expressionStack.length > 0) {
				depth = expressionStack.pop() as number;
				out += c;
				i += 1;
				copyTemplateText();
				continue;
			}
			depth -= 1;
		}

		if (WORD.test(c)) {
			let j = i;
			while (j < n && WORD.test(src[j] as string)) {
				j += 1;
			}
			prev = src.slice(i, j);
			out += prev;
			i = j;
			continue;
		}

		out += c;
		i += 1;
		if (!/\s/.test(c)) {
			prev = c;
		}
	}

	const code = `${out.replace(/^(\s*\r?\n)+/, "").replace(/[ \t\r\n]+$/, "")}${eol}`;
	return { code, removed };
}

function collectFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory)) {
		if (entry === "node_modules") {
			continue;
		}
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			files.push(...collectFiles(path));
		} else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) {
			files.push(path);
		}
	}
	return files;
}

if (import.meta.main) {
	const dryRun = process.argv.includes("--dry-run");
	const keepJsDoc = process.argv.includes("--keep-jsdoc");
	let totalRemoved = 0;
	let changedFiles = 0;

	for (const directory of DIRECTORIES) {
		for (const file of collectFiles(directory)) {
			const original = readFileSync(file, "utf8");
			const { code, removed } = stripComments(original, keepJsDoc);
			if (code === original) {
				continue;
			}
			changedFiles += 1;
			totalRemoved += removed;
			console.log(
				`${dryRun ? "[simulação] " : ""}${file}: ${removed} comentário(s)`,
			);
			if (!dryRun) {
				writeFileSync(file, code);
			}
		}
	}
	console.log(
		`\n${dryRun ? "Removeria" : "Removidos"} ${totalRemoved} comentário(s) em ${changedFiles} arquivo(s).`,
	);
}
