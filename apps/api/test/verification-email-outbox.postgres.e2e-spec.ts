import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env.OUTBOX_TEST_DATABASE_URL;

function createPsqlEnvironment(): NodeJS.ProcessEnv | undefined {
  if (!databaseUrl) {
    return undefined;
  }

  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname) ||
    !databaseName.endsWith("_test")
  ) {
    throw new Error(
      "OUTBOX_TEST_DATABASE_URL must target a loopback PostgreSQL database ending in _test.",
    );
  }

  const environment = { ...process.env };
  delete environment.PGSERVICE;
  delete environment.PGSERVICEFILE;
  delete environment.PGHOSTADDR;
  environment.PGHOST = parsed.hostname.replace(/^\[|\]$/g, "");
  environment.PGPORT = parsed.port || "5432";
  environment.PGDATABASE = databaseName;
  environment.PGUSER = decodeURIComponent(parsed.username);
  environment.PGPASSWORD = decodeURIComponent(parsed.password);
  environment.PGSSLMODE = "disable";
  return environment;
}

const psqlEnvironment = createPsqlEnvironment();
const postgresDescribe = psqlEnvironment ? describe : describe.skip;

interface PsqlProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completed: Promise<string>;
  readonly started: Promise<void>;
}

function startPsql(sql: string, startMarker?: string): PsqlProcess {
  const child = spawn(process.env.OUTBOX_TEST_PSQL_PATH || "psql", [
    "-X",
    "-qAt",
    "-v",
    "ON_ERROR_STOP=1",
    "-F",
    "|",
  ], {
    env: psqlEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let startResolved = false;
  let resolveStarted: () => void = () => undefined;
  let rejectStarted: (error: Error) => void = () => undefined;
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const completed = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (startMarker && output.includes(startMarker) && !startResolved) {
        startResolved = true;
        resolveStarted();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      void chunk;
    });
    child.on("error", () => {
      const error = new Error("Could not start the PostgreSQL test client.");
      if (!startResolved) {
        startResolved = true;
        rejectStarted(error);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (startMarker && !startResolved) {
        startResolved = true;
        rejectStarted(new Error("PostgreSQL session ended before acquiring its test row."));
      }
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`PostgreSQL test client exited with status ${code}.`));
      }
    });
  });

  child.stdin.end(sql);
  return { child, completed, started };
}

function runPsql(sql: string): Promise<string> {
  return startPsql(sql).completed;
}

postgresDescribe("Verification email outbox PostgreSQL behavior", () => {
  const userId = randomUUID();
  const challengeId = randomUUID();
  const outboxId = randomUUID();
  const previousLockToken = randomUUID();
  let fixturesCreated = false;

  beforeAll(async () => {
    const tableExists = await runPsql(
      `SELECT to_regclass('public.verification_email_outbox') IS NOT NULL;`,
    );
    if (tableExists !== "t") {
      throw new Error(
        "Apply the API migrations to the dedicated local outbox test database before running this suite.",
      );
    }

    await runPsql(`
      BEGIN;
      INSERT INTO "users" ("id", "email", "status", "updated_at")
      VALUES ('${userId}', 'outbox-${userId}@example.test', 'PENDING_VERIFICATION', NOW());
      INSERT INTO "verification_challenges" (
        "id", "user_id", "purpose", "token_hash", "expires_at"
      ) VALUES (
        '${challengeId}', '${userId}', 'EMAIL_VERIFICATION',
        'outbox-test-${challengeId}', NOW() + INTERVAL '1 hour'
      );
      INSERT INTO "verification_email_outbox" (
        "id", "challenge_id", "token_ciphertext", "token_nonce", "token_auth_tag"
      ) VALUES (
        '${outboxId}', '${challengeId}', 'test-ciphertext', 'test-nonce', 'test-tag'
      );
      COMMIT;
    `);
    fixturesCreated = true;
  });

  beforeEach(async () => {
    await runPsql(`
      UPDATE "verification_email_outbox"
      SET
        "claim_count" = 0,
        "abandoned_claim_count" = 0,
        "delivery_attempts" = 0,
        "last_delivery_attempt_lock_token" = NULL,
        "available_at" = NOW(),
        "locked_at" = NULL,
        "lock_token" = NULL,
        "delivered_at" = NULL,
        "failed_at" = NULL,
        "failure_code" = NULL
      WHERE "id" = '${outboxId}';
    `);
  });

  afterAll(async () => {
    if (!fixturesCreated) {
      return;
    }

    await runPsql(`
      DELETE FROM "verification_email_outbox" WHERE "id" = '${outboxId}';
      DELETE FROM "verification_challenges" WHERE "id" = '${challengeId}';
      DELETE FROM "users" WHERE "id" = '${userId}';
    `);
  });

  it("uses SKIP LOCKED so concurrent claimers do not block on the same row", async () => {
    const claimSql = `
      WITH candidates AS (
        SELECT "id"
        FROM "verification_email_outbox"
        WHERE "id" = '${outboxId}'
          AND "delivered_at" IS NULL
          AND "failed_at" IS NULL
          AND "available_at" <= NOW()
          AND ("locked_at" IS NULL OR "locked_at" < NOW() - INTERVAL '5 minutes')
        ORDER BY "created_at"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "verification_email_outbox" AS outbox
      SET
        "locked_at" = NOW(),
        "lock_token" = gen_random_uuid(),
        "claim_count" = outbox."claim_count" + 1
      FROM candidates
      WHERE outbox."id" = candidates."id"
      RETURNING outbox."id";
    `;
    const holder = startPsql(
      `BEGIN; ${claimSql} SELECT pg_sleep(1); COMMIT;`,
      outboxId,
    );

    try {
      await holder.started;
      const skipped = await runPsql(`BEGIN; ${claimSql} COMMIT;`);
      expect(skipped).toBe("");
    } finally {
      await holder.completed;
    }
  });

  it("reclaims stale leases without spending delivery attempts and fences the old token", async () => {
    await runPsql(`
      UPDATE "verification_email_outbox"
      SET "locked_at" = NOW() - INTERVAL '6 minutes',
          "lock_token" = '${previousLockToken}'
      WHERE "id" = '${outboxId}';
    `);

    const reclaimed = await runPsql(`
      WITH candidates AS (
        SELECT
          "id",
          ("locked_at" IS NOT NULL
            AND "locked_at" < NOW() - INTERVAL '5 minutes') AS "was_abandoned"
        FROM "verification_email_outbox"
        WHERE "id" = '${outboxId}'
          AND "delivered_at" IS NULL
          AND "failed_at" IS NULL
          AND "available_at" <= NOW()
          AND ("locked_at" IS NULL OR "locked_at" < NOW() - INTERVAL '5 minutes')
        ORDER BY "created_at"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "verification_email_outbox" AS outbox
      SET
        "locked_at" = NOW(),
        "lock_token" = gen_random_uuid(),
        "claim_count" = outbox."claim_count" + 1,
        "abandoned_claim_count" = outbox."abandoned_claim_count"
          + CASE WHEN candidates."was_abandoned" THEN 1 ELSE 0 END
      FROM candidates
      WHERE outbox."id" = candidates."id"
      RETURNING outbox."lock_token", outbox."claim_count",
        outbox."abandoned_claim_count", outbox."delivery_attempts";
    `);
    const [newLockToken, claims, abandonedClaims, deliveryAttempts] =
      reclaimed.split("|");

    expect(newLockToken).not.toBe(previousLockToken);
    expect([claims, abandonedClaims, deliveryAttempts]).toEqual(["1", "1", "0"]);

    const staleAttempt = await runPsql(`
      UPDATE "verification_email_outbox"
      SET "delivery_attempts" = "delivery_attempts" + 1
      WHERE "id" = '${outboxId}' AND "lock_token" = '${previousLockToken}'
      RETURNING "delivery_attempts";
    `);
    expect(staleAttempt).toBe("");

    const firstAttempt = await runPsql(`
      UPDATE "verification_email_outbox"
      SET "delivery_attempts" = "delivery_attempts" + 1,
          "last_delivery_attempt_lock_token" = "lock_token"
      WHERE "id" = '${outboxId}'
        AND "lock_token" = '${newLockToken}'
        AND "last_delivery_attempt_lock_token" IS DISTINCT FROM "lock_token"
        AND "delivery_attempts" < 8
      RETURNING "delivery_attempts";
    `);
    const duplicateAttempt = await runPsql(`
      UPDATE "verification_email_outbox"
      SET "delivery_attempts" = "delivery_attempts" + 1
      WHERE "id" = '${outboxId}'
        AND "lock_token" = '${newLockToken}'
        AND "last_delivery_attempt_lock_token" IS DISTINCT FROM "lock_token"
      RETURNING "delivery_attempts";
    `);
    expect(firstAttempt).toBe("1");
    expect(duplicateAttempt).toBe("");

    await runPsql(`
      UPDATE "verification_email_outbox"
      SET "claim_count" = 8, "delivery_attempts" = 8
      WHERE "id" = '${outboxId}';
    `);
    const exhaustedAttempt = await runPsql(`
      UPDATE "verification_email_outbox"
      SET "delivery_attempts" = "delivery_attempts" + 1
      WHERE "id" = '${outboxId}' AND "delivery_attempts" < 8
      RETURNING "delivery_attempts";
    `);
    expect(exhaustedAttempt).toBe("");
  });

  it("rolls back outbox state changes with the surrounding transaction", async () => {
    const result = await runPsql(`
      BEGIN;
      UPDATE "verification_email_outbox"
      SET "delivered_at" = NOW()
      WHERE "id" = '${outboxId}';
      ROLLBACK;
      SELECT "delivered_at" IS NULL
      FROM "verification_email_outbox"
      WHERE "id" = '${outboxId}';
    `);

    expect(result).toBe("t");
  });
});
