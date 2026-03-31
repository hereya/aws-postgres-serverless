# hereya-aws-postgres-serverless

Creates a **dedicated database and user** inside an existing Aurora Serverless v2 cluster via the Data API. Exports connection details, credentials, and a scoped IAM policy for the app to access its own database.

This package consumes the shared Aurora cluster from `hereya/aws-aurora-dataapi` (Stack 1). Its outputs flow into `hereyaProjectEnv` for the deploy package (`hereya/aws-mcp-app-lambda`), which attaches the scoped IAM policy and passes connection details to the app Lambda.

## Architecture

```
┌─────────────────────────────────────────────────┐
│        Aurora Serverless v2 PostgreSQL           │
│        (from hereya/aws-aurora-dataapi)          │
│                                                  │
│  ┌──────────────┐                               │
│  │ db_my_app    │  <- Created by this package   │
│  │              │                                │
│  │ user_my_app  │  <- Dedicated user with       │
│  │              │     credentials in Secrets Mgr │
│  └──────────────┘                               │
└─────────────────────────────────────────────────┘
          ^
          | Custom Resource Lambda
          | (CREATE DATABASE + CREATE USER via Data API)
```

## AWS Resources Created

- **Custom Resource Lambda** -- Executes SQL via the Data API to create the database, user, and grant privileges
- **Secrets Manager Secret** -- Stores the app user's credentials (username, password, database name, cluster ARN)
- **CloudFormation Custom Resource** -- Triggers the Lambda on stack create/delete

## Inputs

Configuration is provided via environment variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `clusterArn` | **Yes** | -- | The ARN of the Aurora cluster (from `hereya/aws-aurora-dataapi` output). |
| `masterSecretArn` | **Yes** | -- | The ARN of the master user secret (from `hereya/aws-aurora-dataapi` output). Used by the provisioner Lambda to authenticate Data API calls. |
| `dbName` | No | `db_{stackName}` | The database name to create. Auto-generated from the sanitized stack name. |
| `appUsername` | No | `user_{stackName}` | The database username to create. Auto-generated from the sanitized stack name. |

## Outputs

| Output | Description | Example Value |
|--------|-------------|---------------|
| `clusterArn` | The ARN of the Aurora cluster (pass-through for the app). | `arn:aws:rds:us-east-1:123:cluster:serverless-abc` |
| `secretArn` | The ARN of the app user secret in Secrets Manager. Contains username, password, dbname, and clusterArn as JSON. | `arn:aws:secretsmanager:us-east-1:123:secret:/my-stack/db-credentials-AbCdEf` |
| `databaseName` | The name of the database created for this app. | `db_my_app` |
| `dbUsername` | The database username created for this app. | `user_my_app` |
| `awsRegion` | The AWS region. | `us-east-1` |
| `iamPolicyAuroraDataApi` | JSON-serialized IAM policy document granting Data API access to the cluster and read access to this app's secret (not the master secret). | `{"Version":"2012-10-17","Statement":[...]}` |

## Usage with Hereya

```bash
hereya add hereya/aws-postgres-serverless \
  -p clusterArn=arn:aws:rds:us-east-1:123:cluster:abc \
  -p masterSecretArn=arn:aws:secretsmanager:us-east-1:123:secret:xyz
```

### In a project with shared infrastructure

The `clusterArn` and `masterSecretArn` inputs are automatically provided when `hereya/aws-aurora-dataapi` is a dependency:

```yaml
packages:
  hereya/aws-aurora-dataapi:
    version: 0.1.0
  hereya/aws-postgres-serverless:
    version: 0.1.0
```

## How It Flows to the App Lambda

The `iamPolicyAuroraDataApi` output key starts with `iamPolicy`, so the deploy package (`hereya/aws-mcp-app-lambda`) automatically detects it and attaches the policy statements to the app Lambda's execution role. The `clusterArn`, `secretArn`, and `databaseName` values are passed as plain environment variables to the Lambda.

The app Lambda uses these to make Data API calls:

```typescript
import { RDSDataClient, ExecuteStatementCommand } from "@aws-sdk/client-rds-data";

const client = new RDSDataClient({});
const result = await client.send(new ExecuteStatementCommand({
  resourceArn: process.env.clusterArn,
  secretArn: process.env.secretArn,
  database: process.env.databaseName,
  sql: "SELECT * FROM my_table",
}));
```

## What the Custom Resource Does

### On Create
1. `CREATE DATABASE "{dbName}"` (idempotent -- ignores "already exists" errors)
2. `CREATE USER "{appUsername}" WITH PASSWORD '{generated}'` (or resets password if user exists)
3. `GRANT ALL PRIVILEGES ON DATABASE "{dbName}" TO "{appUsername}"`
4. `GRANT ALL ON SCHEMA public TO "{appUsername}"` (on the new database)
5. Stores the generated password in the Custom Resource response

### On Update
No-op. Database and user persist across updates.

### On Delete
Revokes privileges but does **not** drop the database or user -- data preservation by default.

## Development

```bash
npm install
npm run build    # Compile TypeScript
npm run watch    # Watch mode
npx cdk synth    # Synthesize CloudFormation template
npx cdk deploy   # Deploy stack
```

## Notes

- The provisioner Lambda uses the **AWS SDK v3** (`@aws-sdk/client-rds-data`) available in the Node.js 22.x Lambda runtime. No bundling needed.
- The app's secret contains JSON: `{"username": "...", "password": "...", "dbname": "...", "clusterArn": "..."}`.
- The IAM policy grants Data API access to the cluster but scopes secret access to only this app's secret (not the master secret).
- Database names and usernames are sanitized: lowercased with non-alphanumeric characters replaced by underscores.
