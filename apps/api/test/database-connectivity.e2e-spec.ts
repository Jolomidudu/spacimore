import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../src/database/prisma.service.js";

const connectivityTestEnabled =
  process.env.RUN_NEON_CONNECTIVITY_TEST === "true";
const databaseUrl = process.env.DATABASE_URL;

if (connectivityTestEnabled && !databaseUrl) {
  throw new Error(
    "RUN_NEON_CONNECTIVITY_TEST=true requires DATABASE_URL to be configured.",
  );
}

const connectivitySuite = connectivityTestEnabled ? describe : describe.skip;

connectivitySuite("Neon database connectivity (read-only)", () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: databaseUrl ?? "" }),
    );
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("executes a read-only PostgreSQL query", async () => {
    const result = await prisma.$queryRaw<Array<{ connectivity_check: number }>>`
      SELECT 1 AS connectivity_check
    `;

    expect(result).toEqual([{ connectivity_check: 1 }]);
  });
});
