/** Fatia mínima do objeto de resposta do Express que a API usa (evita depender dos tipos do Express). */
export interface HttpResponse {
	status(code: number): unknown;
	setHeader(name: string, value: string): unknown;
	json(body: unknown): unknown;
}
