const crypto = require("crypto");

async function executeStatement(clusterArn, secretArn, sql, database) {
  const { RDSDataClient, ExecuteStatementCommand } = require("@aws-sdk/client-rds-data");
  const client = new RDSDataClient({ region: process.env.AWS_REGION || "us-east-1" });
  const params = { resourceArn: clusterArn, secretArn, sql };
  if (database) params.database = database;
  return client.send(new ExecuteStatementCommand(params));
}

function generatePassword() {
  return crypto.randomBytes(24).toString("base64url");
}

// cr.Provider expects: return { PhysicalResourceId, Data }
// It handles the CloudFormation callback automatically.
exports.handler = async function (event) {
  const { ClusterArn, MasterSecretArn, DatabaseName, AppUsername, AutoDelete } = event.ResourceProperties;
  const physicalResourceId = event.PhysicalResourceId || `db-${DatabaseName}-${AppUsername}`;

  if (event.RequestType === "Create") {
    const password = generatePassword();

    // Create database (idempotent)
    try {
      await executeStatement(ClusterArn, MasterSecretArn, `CREATE DATABASE "${DatabaseName}"`);
    } catch (e) {
      if (!e.message?.includes("already exists")) throw e;
    }

    // Create user (or reset password if exists)
    try {
      await executeStatement(ClusterArn, MasterSecretArn, `CREATE USER "${AppUsername}" WITH PASSWORD '${password}'`);
    } catch (e) {
      if (e.message?.includes("already exists")) {
        await executeStatement(ClusterArn, MasterSecretArn, `ALTER USER "${AppUsername}" WITH PASSWORD '${password}'`);
      } else {
        throw e;
      }
    }

    // Grant privileges
    await executeStatement(ClusterArn, MasterSecretArn, `GRANT ALL PRIVILEGES ON DATABASE "${DatabaseName}" TO "${AppUsername}"`);
    await executeStatement(ClusterArn, MasterSecretArn, `GRANT ALL ON SCHEMA public TO "${AppUsername}"`, DatabaseName);

    return { PhysicalResourceId: physicalResourceId, Data: { Password: password } };
  }

  if (event.RequestType === "Update") {
    return { PhysicalResourceId: physicalResourceId };
  }

  if (event.RequestType === "Delete") {
    try {
      await executeStatement(ClusterArn, MasterSecretArn, `REVOKE ALL PRIVILEGES ON DATABASE "${DatabaseName}" FROM "${AppUsername}"`);
    } catch {
      // Ignore errors on cleanup
    }
    if (AutoDelete === "true") {
      try {
        await executeStatement(ClusterArn, MasterSecretArn, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DatabaseName}' AND pid <> pg_backend_pid()`);
      } catch { /* ignore */ }
      try {
        await executeStatement(ClusterArn, MasterSecretArn, `DROP DATABASE IF EXISTS "${DatabaseName}"`);
      } catch { /* ignore */ }
      try {
        await executeStatement(ClusterArn, MasterSecretArn, `DROP USER IF EXISTS "${AppUsername}"`);
      } catch { /* ignore */ }
    }
    return { PhysicalResourceId: physicalResourceId };
  }
};
