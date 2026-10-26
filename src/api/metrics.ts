/** Contadores em memória no formato de texto do Prometheus. */
export class Metrics {
	private readonly counters = new Map<
		string,
		{ name: string; labels: Record<string, string>; value: number }
	>();

	inc(name: string, labels: Record<string, string> = {}, by = 1): void {
		const key = `${name}|${JSON.stringify(Object.entries(labels).sort())}`;
		const current = this.counters.get(key);
		if (current === undefined) {
			this.counters.set(key, { name, labels, value: by });
		} else {
			current.value += by;
		}
	}

	render(): string {
		const lines: string[] = [];
		for (const { name, labels, value } of this.counters.values()) {
			const rendered = Object.entries(labels)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(
					([key, labelValue]) => `${key}="${labelValue.replace(/"/g, '\\"')}"`,
				)
				.join(",");
			lines.push(`${name}${rendered === "" ? "" : `{${rendered}}`} ${value}`);
		}
		return `${lines.sort().join("\n")}\n`;
	}
}
