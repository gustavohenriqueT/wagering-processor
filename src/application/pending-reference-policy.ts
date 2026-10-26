export interface PendingReferencePolicy {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
	ttlMs: number;
}

export const DEFAULT_PENDING_POLICY: PendingReferencePolicy = {
	maxAttempts: 10,
	baseDelayMs: 2_000,
	maxDelayMs: 300_000,
	ttlMs: 3_600_000,
};

export function pendingBackoffMs(
	policy: PendingReferencePolicy,
	attempts: number,
): number {
	return Math.min(policy.baseDelayMs * 2 ** attempts, policy.maxDelayMs);
}
