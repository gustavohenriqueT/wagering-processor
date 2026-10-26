const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

interface Series {
	name: string;
	labels: Record<string, string>;
	value: number;
}

interface HistogramSeries {
	name: string;
	labels: Record<string, string>;
	buckets: number[];
	sum: number;
	count: number;
}

function renderLabels(labels: Record<string, string>): string {
	const rendered = Object.entries(labels)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, value]) => `${key}="${value.replace(/"/g, '\\"')}"`)
		.join(",");
	return rendered === "" ? "" : `{${rendered}}`;
}

function keyOf(name: string, labels: Record<string, string>): string {
	return `${name}${renderLabels(labels)}`;
}

export class Metrics {
	private readonly counters = new Map<string, Series>();
	private readonly gauges = new Map<string, Series>();
	private readonly histograms = new Map<string, HistogramSeries>();

	inc(name: string, labels: Record<string, string> = {}, by = 1): void {
		const key = keyOf(name, labels);
		const current = this.counters.get(key);
		if (current === undefined) {
			this.counters.set(key, { name, labels, value: by });
		} else {
			current.value += by;
		}
	}

	set(name: string, value: number, labels: Record<string, string> = {}): void {
		this.gauges.set(keyOf(name, labels), { name, labels, value });
	}

	observe(
		name: string,
		seconds: number,
		labels: Record<string, string> = {},
	): void {
		const key = keyOf(name, labels);
		let series = this.histograms.get(key);
		if (series === undefined) {
			series = {
				name,
				labels,
				buckets: LATENCY_BUCKETS.map(() => 0),
				sum: 0,
				count: 0,
			};
			this.histograms.set(key, series);
		}
		LATENCY_BUCKETS.forEach((bound, index) => {
			if (seconds <= bound) {
				series.buckets[index] = (series.buckets[index] ?? 0) + 1;
			}
		});
		series.sum += seconds;
		series.count += 1;
	}

	counter(name: string, labels: Record<string, string> = {}): number {
		return this.counters.get(keyOf(name, labels))?.value ?? 0;
	}

	render(): string {
		const lines: string[] = [];
		for (const { name, labels, value } of [
			...this.counters.values(),
			...this.gauges.values(),
		]) {
			lines.push(`${name}${renderLabels(labels)} ${value}`);
		}
		for (const series of this.histograms.values()) {
			LATENCY_BUCKETS.forEach((bound, index) => {
				lines.push(
					`${series.name}_bucket${renderLabels({ ...series.labels, le: String(bound) })} ${series.buckets[index] ?? 0}`,
				);
			});
			lines.push(
				`${series.name}_bucket${renderLabels({ ...series.labels, le: "+Inf" })} ${series.count}`,
			);
			lines.push(
				`${series.name}_sum${renderLabels(series.labels)} ${series.sum}`,
			);
			lines.push(
				`${series.name}_count${renderLabels(series.labels)} ${series.count}`,
			);
		}
		return `${lines.sort().join("\n")}\n`;
	}
}
