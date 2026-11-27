CREATE TABLE "verification_email_outbox" (
    "id" UUID NOT NULL,
    "challenge_id" UUID NOT NULL,
    "token_ciphertext" TEXT NOT NULL,
    "token_nonce" VARCHAR(24) NOT NULL,
    "token_auth_tag" VARCHAR(32) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(6),
    "lock_token" UUID,
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "failure_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_email_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "verification_email_outbox_attempts_nonnegative_check" CHECK ("attempts" >= 0),
    CONSTRAINT "verification_email_outbox_lock_state_check"
        CHECK (("locked_at" IS NULL) = ("lock_token" IS NULL)),
    CONSTRAINT "verification_email_outbox_terminal_state_check"
        CHECK (
            "failed_at" IS NULL
            OR (
                "failure_code" IS NOT NULL
                AND "delivered_at" IS NULL
                AND "locked_at" IS NULL
                AND "lock_token" IS NULL
            )
        ),
    CONSTRAINT "verification_email_outbox_delivery_state_check"
        CHECK (
            "delivered_at" IS NULL
            OR (
                "failed_at" IS NULL
                AND "locked_at" IS NULL
                AND "lock_token" IS NULL
            )
        ),
    CONSTRAINT "verification_email_outbox_failure_code_check"
        CHECK (
            "failure_code" IS NULL
            OR "failure_code" IN (
                'ACCOUNT_NOT_PENDING',
                'CHALLENGE_CONSUMED',
                'CHALLENGE_EXPIRED',
                'CHALLENGE_NOT_FOUND',
                'CHALLENGE_SUPERSEDED',
                'DECRYPTION_FAILED',
                'DELIVERY_INTERNAL_ERROR',
                'DELIVERY_UNCERTAIN',
                'PROVIDER_AUTHENTICATION',
                'PROVIDER_CONFIGURATION',
                'PROVIDER_REJECTED',
                'PROVIDER_TRANSIENT',
                'RETRIES_EXHAUSTED',
                'WRONG_CHALLENGE_PURPOSE'
            )
        ),
    CONSTRAINT "verification_email_outbox_challenge_id_fkey" FOREIGN KEY ("challenge_id")
        REFERENCES "verification_challenges"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "verification_email_outbox_challenge_id_key"
    ON "verification_email_outbox"("challenge_id");

CREATE INDEX "verification_email_outbox_pending_idx"
    ON "verification_email_outbox"(
        "delivered_at",
        "failed_at",
        "available_at",
        "locked_at",
        "created_at"
    );
