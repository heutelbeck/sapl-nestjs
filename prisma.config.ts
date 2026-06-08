import { defineConfig } from 'prisma/config';

// Test-only Prisma configuration for the integration suite. Prisma 7 reads
// the schema location from here; the integration test supplies the dynamic
// Postgres URL to `db push` via --url and to the runtime client via the
// Postgres driver adapter, so no native query engine is required.
export default defineConfig({
  schema: 'test/integration/prisma/schema.prisma',
});
