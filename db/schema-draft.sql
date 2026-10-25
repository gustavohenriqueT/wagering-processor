CREATE TABLE wallets (
    id uuid PRIMARY KEY,
    player_id text NOT NULL,
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    balance numeric(19, 2) NOT NULL DEFAULT 0 CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
    version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
);

CREATE TABLE wager_transactions (
    id uuid PRIMARY KEY,
    provider_id text NOT NULL,
    external_transaction_id text NOT NULL,
    idempotency_key text NOT NULL,
    payload_hash text NOT NULL,
    wallet_id uuid NOT NULL REFERENCES wallets (id),
    player_id text NOT NULL,
    round_id text NOT NULL,
    game_id text NOT NULL,
    kind text NOT NULL CHECK (
        kind IN (
            'OPENING',
            'BET',
            'WIN',
            'LOSS',
            'REFUND',
            'ROLLBACK'
        )
    ),
    amount numeric(19, 2) NOT NULL CHECK (amount >= 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    reference_external_transaction_id text,
    reference_transaction_id uuid REFERENCES wager_transactions (id),
    status text NOT NULL CHECK (
        status IN (
            'PENDING',
            'PENDING_REFERENCE',
            'PROCESSED',
            'REJECTED',
            'FAILED'
        )
    ),
    failure_code text,
    observed_balance numeric(19, 2) CHECK (observed_balance >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    CONSTRAINT uq_tx_provider_external UNIQUE (
        provider_id,
        external_transaction_id
    ),
    CONSTRAINT uq_tx_idempotency UNIQUE (provider_id, idempotency_key),
    CONSTRAINT ck_reference_required CHECK (
        (
            kind IN ('REFUND', 'ROLLBACK')
        ) = (
            reference_external_transaction_id IS NOT NULL
        )
    ),
    CONSTRAINT ck_failure_code CHECK (
        (
            status IN ('REJECTED', 'FAILED')
        ) = (failure_code IS NOT NULL)
    ),
    CONSTRAINT ck_processed_at CHECK (
        (status = 'PROCESSED') = (processed_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX uq_one_processed_reversal ON wager_transactions (reference_transaction_id)
WHERE
    status = 'PROCESSED'
    AND kind IN ('REFUND', 'ROLLBACK');

CREATE TABLE wallet_ledger_entries (
    seq bigint GENERATED ALWAYS AS IDENTITY,
    id uuid PRIMARY KEY,
    wallet_id uuid NOT NULL REFERENCES wallets (id),
    transaction_id uuid NOT NULL REFERENCES wager_transactions (id),
    direction text NOT NULL CHECK (
        direction IN ('DEBIT', 'CREDIT')
    ),
    amount numeric(19, 2) NOT NULL CHECK (amount > 0),
    balance_before numeric(19, 2) NOT NULL CHECK (balance_before >= 0),
    balance_after numeric(19, 2) NOT NULL CHECK (balance_after >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_ledger_wallet_tx UNIQUE (wallet_id, transaction_id),
    CONSTRAINT ck_ledger_arithmetic CHECK (
        (
            direction = 'DEBIT'
            AND balance_after = balance_before - amount
        )
        OR (
            direction = 'CREDIT'
            AND balance_after = balance_before + amount
        )
    )
);

CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq);

CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_immutable
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TABLE inbox_messages (
    consumer_name text NOT NULL,
    message_id text NOT NULL,
    payload_hash text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
    id uuid PRIMARY KEY,
    aggregate_id text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz,
    published_at timestamptz
);

CREATE INDEX ix_outbox_pending ON outbox_messages (occurred_at)
WHERE
    published_at IS NULL;