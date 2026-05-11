const crypto = require("crypto");
const { RDSDataClient, ExecuteStatementCommand } = require("@aws-sdk/client-rds-data");

const rds = new RDSDataClient({ region: process.env.AWS_REGION || "us-east-1" });

// Error names returned by the RDS Data API while an Aurora Serverless v2
// cluster is resuming, scaling, or otherwise momentarily unreachable. All
// of these are transient and resolve themselves within tens of seconds.
const TRANSIENT_ERROR_NAMES = new Set([
  "DatabaseResumingException",
  "DatabaseNotFoundException",
  "ServiceUnavailableException",
  "ThrottlingException",
  "TooManyRequestsException",
  "InternalServerErrorException",
]);

// Some transient conditions surface as a generic BadRequestException with
// a message that hints at scaling/resuming. Match those by substring.
const TRANSIENT_MESSAGE_PATTERNS = [
  /currently resuming/i,
  /currently scaling/i,
  /is paused/i,
  /not currently available/i,
  /communications link failure/i,
];

function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT_ERROR_NAMES.has(err.name)) return true;
  const msg = err.message || "";
  return TRANSIENT_MESSAGE_PATTERNS.some((p) => p.test(msg));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Exponential backoff with jitter. Total budget is ~50s by default which
// fits inside the 60s Lambda timeout configured by the stack.
async function withRetry(fn, { label, maxAttempts = 8, baseMs = 1500, capMs = 15000 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err)) throw err;
      attempt += 1;
      if (attempt >= maxAttempts) break;
      const expDelay = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const jitter = Math.floor(Math.random() * 500);
      const delay = expDelay + jitter;
      console.log(
        `[db-provisioner] ${label || "rds-data call"} failed with transient ${err.name}: ${err.message}. ` +
          `Retrying in ${delay}ms (attempt ${attempt}/${maxAttempts}).`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function executeStatement(clusterArn, secretArn, sql, database, { retryLabel } = {}) {
  const params = { resourceArn: clusterArn, secretArn, sql };
  if (database) params.database = database;
  return withRetry(
    () => rds.send(new ExecuteStatementCommand(params)),
    { label: retryLabel || sql.slice(0, 40) }
  );
}

// Cheap statement used purely to wake the cluster up before doing any
// real work. Has its own larger retry budget because the first call after
// a long pause can take 30-60s to come back.
async function ensureClusterAwake(clusterArn, secretArn) {
  await withRetry(
    () =>
      rds.send(
        new ExecuteStatementCommand({
          resourceArn: clusterArn,
          secretArn,
          sql: "SELECT 1",
        })
      ),
    { label: "warmup SELECT 1", maxAttempts: 12, baseMs: 2000, capMs: 15000 }
  );
}

function generatePassword() {
  return crypto.randomBytes(24).toString("base64url");
}

// cr.Provider expects: return { PhysicalResourceId, Data }
// It handles the CloudFormation callback automatically.
exports.handler = async function (event) {
  const { ClusterArn, MasterSecretArn, DatabaseName, AppUsername, AutoDelete } = event.ResourceProperties;
  const physicalResourceId = event.PhysicalResourceId || `db-${DatabaseName}-${AppUsername}`;

  // Wake the cluster before doing anything else. This absorbs the
  // multi-second resume delay once and lets subsequent DDL run normally.
  await ensureClusterAwake(ClusterArn, MasterSecretArn);

  if (event.RequestType === "Create") {
    const password = generatePassword();

    // Create database (idempotent)
    try {
      await executeStatement(ClusterArn, MasterSecretArn, `CREATE DATABASE "${DatabaseName}"`, undefined, {
        retryLabel: "CREATE DATABASE",
      });
    } catch (e) {
      if (!e.message?.includes("already exists")) throw e;
    }

    // Create user (or reset password if exists)
    try {
      await executeStatement(
        ClusterArn,
        MasterSecretArn,
        `CREATE USER "${AppUsername}" WITH PASSWORD '${password}'`,
        undefined,
        { retryLabel: "CREATE USER" }
      );
    } catch (e) {
      if (e.message?.includes("already exists")) {
        await executeStatement(
          ClusterArn,
          MasterSecretArn,
          `ALTER USER "${AppUsername}" WITH PASSWORD '${password}'`,
          undefined,
          { retryLabel: "ALTER USER" }
        );
      } else {
        throw e;
      }
    }

    // Grant privileges
    await executeStatement(
      ClusterArn,
      MasterSecretArn,
      `GRANT ALL PRIVILEGES ON DATABASE "${DatabaseName}" TO "${AppUsername}"`,
      undefined,
      { retryLabel: "GRANT DATABASE" }
    );
    await executeStatement(
      ClusterArn,
      MasterSecretArn,
      `GRANT ALL ON SCHEMA public TO "${AppUsername}"`,
      DatabaseName,
      { retryLabel: "GRANT SCHEMA" }
    );

    return { PhysicalResourceId: physicalResourceId, Data: { Password: password } };
  }

  if (event.RequestType === "Update") {
    return { PhysicalResourceId: physicalResourceId };
  }

  if (event.RequestType === "Delete") {
    try {
      await executeStatement(
        ClusterArn,
        MasterSecretArn,
        `REVOKE ALL PRIVILEGES ON DATABASE "${DatabaseName}" FROM "${AppUsername}"`,
        undefined,
        { retryLabel: "REVOKE" }
      );
    } catch {
      // Ignore errors on cleanup
    }
    if (AutoDelete === "true") {
      try {
        await executeStatement(
          ClusterArn,
          MasterSecretArn,
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DatabaseName}' AND pid <> pg_backend_pid()`,
          undefined,
          { retryLabel: "TERMINATE BACKENDS" }
        );
      } catch { /* ignore */ }
      try {
        await executeStatement(
          ClusterArn,
          MasterSecretArn,
          `DROP DATABASE IF EXISTS "${DatabaseName}"`,
          undefined,
          { retryLabel: "DROP DATABASE" }
        );
      } catch { /* ignore */ }
      try {
        await executeStatement(
          ClusterArn,
          MasterSecretArn,
          `DROP USER IF EXISTS "${AppUsername}"`,
          undefined,
          { retryLabel: "DROP USER" }
        );
      } catch { /* ignore */ }
    }
    return { PhysicalResourceId: physicalResourceId };
  }
};
