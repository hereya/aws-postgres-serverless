#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { HereyaAwsPostgresServerlessStack } from "../lib/hereya-aws-postgres-serverless-stack";

const app = new cdk.App();
new HereyaAwsPostgresServerlessStack(app, process.env.STACK_NAME!, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
