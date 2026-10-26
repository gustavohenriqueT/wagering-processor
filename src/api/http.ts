export interface HttpResponse {
	status(code: number): unknown;
	setHeader(name: string, value: string): unknown;
	json(body: unknown): unknown;
}
