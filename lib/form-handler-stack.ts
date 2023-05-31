import {
  aws_dynamodb,
  aws_lambda,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  CfnOutput,

} from "aws-cdk-lib";
import { Construct } from 'constructs';
import { HttpLambdaIntegration } from "@aws-cdk/aws-apigatewayv2-integrations-alpha";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as apigwv2 from '@aws-cdk/aws-apigatewayv2-alpha';
import * as actions from "aws-cdk-lib/aws-ses-actions";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dotenv from 'dotenv';


// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class FormHandlerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Load environment variables from .env file
    dotenv.config();

    // Validate environment variables
    const formTableName = process.env.FORM_TABLE_NAME;
    if (!formTableName) {
      throw new Error('Form table name is undefined. Make sure it is set in the environment variables.');
    }

    const formSubmissionTableName = process.env.FORM_SUBMISSIONS_TABLE_NAME;
    if (!formSubmissionTableName) {
      throw new Error('Form submission table name is undefined. Make sure it is set in the environment variables.');
    }

    const emailFrom = process.env.EMAIL_FROM;
    if (!emailFrom) {
      throw new Error('Email from address is undefined. Make sure it is set in the environment variables.');
    }

    const emailTo = process.env.EMAIL_TO;
    if (!emailTo) {
      throw new Error('Email to address is undefined. Make sure it is set in the environment variables.');
    }

    // Check if environment is production
    const isProd = process.env.NODE_ENV === 'production';
    // The code that defines your stack goes here

    //DynamoDB Tables

    // Create a DynamoDB table to store form configurations and admin properties
    const formTable = new aws_dynamodb.Table(this, formTableName, {
      tableName: formTableName,
      partitionKey: {
        name: 'formId',
        type: aws_dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'formName',
        type: aws_dynamodb.AttributeType.STRING,
      },
      billingMode: aws_dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });


    // Create a DynamoDB table to store form submissions
    const table = new aws_dynamodb.Table(this, formSubmissionTableName, {
      tableName: formSubmissionTableName,
      partitionKey: {
        name: 'id',
        type: aws_dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: aws_dynamodb.AttributeType.STRING,
      },
      billingMode: aws_dynamodb.BillingMode.PAY_PER_REQUEST, // Switching to PAY_PER_REQUEST as it's generally more cost effective for GSIs
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    table.addGlobalSecondaryIndex({
      indexName: 'formId-timestamp-index',
      partitionKey: {
        name: 'formId',
        type: aws_dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: aws_dynamodb.AttributeType.STRING,
      },
      projectionType: aws_dynamodb.ProjectionType.ALL,
    });

    table.addGlobalSecondaryIndex({
      indexName: 'formId-sourceIP-index',
      partitionKey: {
        name: 'formId',
        type: aws_dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'sourceIP',
        type: aws_dynamodb.AttributeType.STRING,
      },
      projectionType: aws_dynamodb.ProjectionType.ALL,
    });

    // Create AWS Lambda function to save form submissions to DynamoDB and send alert emails
    let lambdaName = "form-handler-lambda";
    const memorySize = 512;
    const dynamoLambda = new NodejsFunction(this, lambdaName, {
      functionName: lambdaName,
      description: "Saves Form submissions to DynamoDB and send alert email",
      runtime: aws_lambda.Runtime.NODEJS_18_X,
      memorySize: memorySize,
      timeout: Duration.seconds(30),
      entry: "functions/form-handler/index.ts", // accepts .js, .jsx, .ts, .tsx and .mjs files
      handler: "handler", // defaults to 'handler'
      retryAttempts: 2,
      bundling: {
        minify: false, // minify code, defaults to false
        // nodeModules: ["request"],
      },
      environment: {
        FORM_TABLE_NAME: formTableName,
        FORM_SUBMISSIONS_TABLE_NAME: formSubmissionTableName,
        EMAIL_FROM: emailFrom,
        EMAIL_TO: emailTo,
      },
      logRetention: aws_logs.RetentionDays.ONE_WEEK,
    });

    // Grant write permissions to our Lambda function for our DynamoDB table
    table.grantWriteData(dynamoLambda);

    // Allow our Lambda function to send emails via SES
    const sesPolicy = new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      effect: iam.Effect.ALLOW,
      resources: ['*'], // You can restrict this to specific resources if needed
    });

    // Add the policy to our Lambda function's role
    dynamoLambda.addToRolePolicy(sesPolicy);

    const logGroup = new aws_logs.LogGroup(this, 'ApiGatewayAccessLogs-FormHandler');

    // Define API Gateway integration with our main Lambda function
    const dynamoLambdaIntegration = new HttpLambdaIntegration(
      "dynamoLambdaIntegration",
      dynamoLambda
    );

    // Create a Lambda function for handling OPTIONS requests (CORS)
    let corsLambdaName = "form-handler-cors-lambda";
    const optionsLambda = new NodejsFunction(this, corsLambdaName, {
      functionName: corsLambdaName,
      description: "Provides dynamic CORS header support",
      runtime: aws_lambda.Runtime.NODEJS_18_X,
      memorySize: memorySize,
      timeout: Duration.seconds(30),
      entry: "functions/cors-handler/index.ts", // accepts .js, .jsx, .ts, .tsx and .mjs files
      handler: "handler", // defaults to 'handler'
      retryAttempts: 2,
      bundling: {
        minify: false, // minify code, defaults to false
        // nodeModules: ["request"],
      },
      environment: {
        FORM_TABLE_NAME: formTableName,
      },
      logRetention: aws_logs.RetentionDays.ONE_WEEK,
    });
    const optionsLambdaIntegration = new HttpLambdaIntegration("optionsLambdaIntegration", optionsLambda);

    const apiName = "form-handler";
    const httpApi = new apigwv2.HttpApi(this, apiName, {
      apiName: apiName,
      defaultIntegration: dynamoLambdaIntegration,
      description: "My Form Handler Service",
    });

    httpApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.POST],
      integration: dynamoLambdaIntegration,
    });

    httpApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.OPTIONS],
      integration: optionsLambdaIntegration,
    });

    // Output the HTTP API Gateway URL as a CloudFormation output
    new CfnOutput(this, 'HttpApiUrl', {
      value: httpApi.url!,
    });

  }
}
