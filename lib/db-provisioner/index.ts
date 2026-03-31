import * as https from "https";
import * as crypto from "crypto";

interface CloudFormationEvent {
  RequestType: "Create" | "Update" | "Delete";
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceProperties: {
    ClusterArn: string;
    MasterSecretArn: string;
    DatabaseName: string;
    AppUsername: string;
  };
}

interface DataApiResponse {
  records?: unknown[][];
}

async function executeStatement(
  clusterArn: string,
  secretArn: string,
  sql: string,
  database?: string
): Promise<DataApiResponse> {
  const region = process.env.AWS_REGION || "us-east-1";
  const hostname = `rds-data.${region}.amazonaws.com`;
  const path = "/Execute";
  const body = JSON.stringify({
    resourceArn: clusterArn,
    secretArn,
    sql,
    ...(database ? { database } : {}),
  });

  // Use AWS SDK v3 available in Lambda runtime
  const {
    RDSDataClient,
    ExecuteStatementCommand,
  } = require("@aws-sdk/client-rds-data");
  const client = new RDSDataClient({ region });
  const command = new ExecuteStatementCommand({
    resourceArn: clusterArn,
    secretArn,
    sql,
    ...(database ? { database } : {}),
  });
  return client.send(command);
}

function generatePassword(): string {
  return crypto.randomBytes(24).toString("base64url");
}

async function sendResponse(
  event: CloudFormationEvent,
  status: "SUCCESS" | "FAILED",
  data: Record<string, string>,
  physicalResourceId: string,
  reason?: string
): Promise<void> {
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
        headers: {
          "Content-Type": "",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      () => resolve()
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function handler(event: CloudFormationEvent): Promise<void> {
  const { ClusterArn, MasterSecretArn, DatabaseName, AppUsername } =
    event.ResourceProperties;
  const physicalResourceId =
    event.PhysicalResourceId || `db-${DatabaseName}-${AppUsername}`;

  try {
    if (event.RequestType === "Create") {
      const password = generatePassword();

      // Create database (IF NOT EXISTS for idempotency)
      await executeStatement(
        ClusterArn,
        MasterSecretArn,
        `SELECT 'CREATE DATABASE ${DatabaseName}' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DatabaseName}')`,
      );
      // Actually create it - pg doesn't support IF NOT EXISTS for CREATE DATABASE
      try {
        await executeStatement(
          ClusterArn,
          MasterSecretArn,
          `CREATE DATABASE "${DatabaseName}"`,
        );
      } catch (e: any) {
        // Ignore "already exists" error
        if (!e.message?.includes("already exists")) throw e;
      }

      // Create user
      try {
        await executeStatement(
          ClusterArn,
          MasterSecretArn,
          `CREATE USER "${AppUsername}" WITH PASSWORD '${password}'`,
        );
      } catch (e: any) {
        // If user already exists, reset password
        if (e.message?.includes("already exists")) {
          await executeStatement(
            ClusterArn,
            MasterSecretArn,
            `ALTER USER "${AppUsername}" WITH PASSWORD '${password}'`,
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
      );

      // Grant schema privileges (connect to the new database)
      await executeStatement(
        ClusterArn,
        MasterSecretArn,
        `GRANT ALL ON SCHEMA public TO "${AppUsername}"`,
        DatabaseName,
      );

      await sendResponse(event, "SUCCESS", { Password: password }, physicalResourceId);
    } else if (event.RequestType === "Update") {
      // Nothing to update — database and user persist
      await sendResponse(event, "SUCCESS", {}, physicalResourceId);
    } else if (event.RequestType === "Delete") {
      // Don't drop database/user on delete — data preservation
      // Just revoke privileges
      try {
        await executeStatement(
          ClusterArn,
          MasterSecretArn,
          `REVOKE ALL PRIVILEGES ON DATABASE "${DatabaseName}" FROM "${AppUsername}"`,
        );
      } catch {
        // Ignore errors on cleanup
      }
      await sendResponse(event, "SUCCESS", {}, physicalResourceId);
    }
  } catch (err: any) {
    console.error("Error:", err);
    await sendResponse(
      event,
      "FAILED",
      {},
      physicalResourceId,
      err.message || "Unknown error"
    );
  }
}
