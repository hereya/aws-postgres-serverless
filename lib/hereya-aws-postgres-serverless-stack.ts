import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import * as path from "path";

export class HereyaAwsPostgresServerlessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const clusterArn = process.env["clusterArn"];
    if (!clusterArn) {
      throw new Error("clusterArn environment variable is required");
    }

    const masterSecretArn = process.env["masterSecretArn"];
    if (!masterSecretArn) {
      throw new Error("masterSecretArn environment variable is required");
    }

    // Database and user names derived from stack name (sanitized)
    const sanitizedName = this.stackName.toLowerCase().replace(/[^a-z0-9]/g, "_");
    const dbName = process.env["dbName"] || `db_${sanitizedName}`;
    const appUsername = process.env["appUsername"] || `user_${sanitizedName}`;

    // Custom Resource Lambda to create database and user via Data API
    const provisionerFn = new lambda.Function(this, "DbProvisioner", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "db-provisioner")),
      memorySize: 128,
      timeout: cdk.Duration.seconds(60),
    });

    // Grant the provisioner access to Data API and master secret
    provisionerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "rds-data:ExecuteStatement",
          "rds-data:BatchExecuteStatement",
        ],
        resources: [clusterArn],
      })
    );
    provisionerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [masterSecretArn],
      })
    );

    // Custom Resource Provider
    const provider = new cr.Provider(this, "DbProvisionerProvider", {
      onEventHandler: provisionerFn,
    });

    // Custom Resource that triggers DB/user creation
    const dbResource = new cdk.CustomResource(this, "DatabaseResource", {
      serviceToken: provider.serviceToken,
      properties: {
        ClusterArn: clusterArn,
        MasterSecretArn: masterSecretArn,
        DatabaseName: dbName,
        AppUsername: appUsername,
      },
    });

    // Store app user credentials in Secrets Manager
    const appPassword = dbResource.getAttString("Password");
    const appSecret = new secrets.Secret(this, "AppUserSecret", {
      secretName: `/${this.stackName}/db-credentials`,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({
          username: appUsername,
          password: appPassword,
          dbname: dbName,
          clusterArn: clusterArn,
        })
      ),
    });

    // IAM policy for Data API access scoped to this app's secret
    const policyDocument = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "rds-data:ExecuteStatement",
            "rds-data:BatchExecuteStatement",
            "rds-data:BeginTransaction",
            "rds-data:CommitTransaction",
            "rds-data:RollbackTransaction",
          ],
          resources: [clusterArn],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["secretsmanager:GetSecretValue"],
          resources: [appSecret.secretArn],
        }),
      ],
    });

    // Store secretArn in SSM so Hereya doesn't auto-resolve it as a secret value.
    // The Lambda needs the ARN itself (to pass to Data API), not the secret content.
    const secretArnParam = new ssm.StringParameter(this, "SecretArnParam", {
      parameterName: `/${this.stackName}/secret-arn`,
      stringValue: appSecret.secretArn,
      description: "ARN of the app database user secret",
    });

    // Outputs — these flow into hereyaProjectEnv for the deploy package
    new cdk.CfnOutput(this, "clusterArn", {
      value: clusterArn,
      description: "The ARN of the Aurora cluster",
    });

    new cdk.CfnOutput(this, "secretArn", {
      value: secretArnParam.parameterArn,
      description: "SSM parameter ARN containing the app user secret ARN",
    });

    new cdk.CfnOutput(this, "databaseName", {
      value: dbName,
      description: "The name of the database created for this app",
    });

    new cdk.CfnOutput(this, "dbUsername", {
      value: appUsername,
      description: "The database username for this app",
    });

    new cdk.CfnOutput(this, "awsRegion", {
      value: this.region,
      description: "The AWS region",
    });

    new cdk.CfnOutput(this, "iamPolicyAuroraDataApi", {
      value: JSON.stringify(policyDocument.toJSON()),
      description:
        "IAM policy for Data API access scoped to this app secret",
    });
  }
}
