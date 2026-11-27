ALTER TABLE "verification_email_outbox"
    ADD COLUMN "claim_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "abandoned_claim_count" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "delivery_attempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "last_delivery_attempt_lock_token" UUID;

-- Preserve the prior mixed claim/dispatch counter and backfill only confirmed
-- provider failures; unaudited crash-boundary requests cannot be reconstructed.
-- Keep the original attempts column so legacy data is not removed by this migration.
WITH confirmed_delivery_failures AS (
    SELECT
        "target_id" AS "challenge_id",
        COUNT(*) AS "attempt_count"
    FROM "audit_logs"
    WHERE "action" = 'AUTH.VERIFICATION_EMAIL_FAILED'
      AND "target_type" = 'VerificationChallenge'
      AND "outcome" IN ('RETRYING', 'TERMINAL')
      AND "metadata"->>'failureCode' IN (
          'DELIVERY_INTERNAL_ERROR',
          'DELIVERY_UNCERTAIN',
          'PROVIDER_AUTHENTICATION',
          'PROVIDER_REJECTED',
          'PROVIDER_TRANSIENT'
      )
    GROUP BY "target_id"
)
UPDATE "verification_email_outbox" AS outbox
SET
    "claim_count" = outbox."attempts",
    "delivery_attempts" = LEAST(
        COALESCE(failures."attempt_count", 0),
        8,
        outbox."attempts"
    )::INTEGER
FROM confirmed_delivery_failures AS failures
WHERE outbox."challenge_id" = failures."challenge_id";

UPDATE "verification_email_outbox"
SET "claim_count" = "attempts"
WHERE "claim_count" = 0 AND "attempts" > 0;

ALTER TABLE "verification_email_outbox"
    ADD CONSTRAINT "verification_email_outbox_claim_count_nonnegative_check"
        CHECK ("claim_count" >= 0),
    ADD CONSTRAINT "verification_email_outbox_abandoned_claim_count_check"
        CHECK (
            "abandoned_claim_count" >= 0
            AND "abandoned_claim_count" <= "claim_count"
        ),
    ADD CONSTRAINT "verification_email_outbox_delivery_attempts_check"
        CHECK (
            "delivery_attempts" BETWEEN 0 AND 8
            AND "delivery_attempts" <= "claim_count"
        );
