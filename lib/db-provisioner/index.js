const https = require("https");
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

function sendResponse(event, status, data, physicalResourceId, reason) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason || "",
    PhysicalResourceId: physicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });

  const url = new URL(event.ResponseURL);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: "PUT",
        headers: { "Content-Type": "", "Content-Length": Buffer.byteLength(body) },
      },
      () => resolve()
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async function (event) {
  const { ClusterArn, MasterSecretArn, DatabaseName, AppUsername, AutoDelete } = event.ResourceProperties;
  const physicalResourceId = event.PhysicalResourceId || `db-${DatabaseName}-${AppUsername}`;

  try {
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

      await sendResponse(event, "SUCCESS", { Password: password }, physicalResourceId);
    } else if (event.RequestType === "Update") {
      await sendResponse(event, "SUCCESS", {}, physicalResourceId);
    } else if (event.RequestType === "Delete") {
      try {
        await executeStatement(ClusterArn, MasterSecretArn, `REVOKE ALL PRIVILEGES ON DATABASE "${DatabaseName}" FROM "${AppUsername}"`);
      } catch {
        // Ignore errors on cleanup
      }
      if (AutoDelete === "true") {
        // Force disconnect all sessions before dropping
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
      await sendResponse(event, "SUCCESS", {}, physicalResourceId);
    }
  } catch (err) {
    console.error("Error:", err);
    await sendResponse(event, "FAILED", {}, physicalResourceId, err.message || "Unknown error");
  }
};
