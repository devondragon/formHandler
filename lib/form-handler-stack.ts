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
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as aws_logs from 'aws-cdk-lib/aws-logs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';
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

    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
      throw new Error('Admin email is undefined. Make sure it is set in the environment variables.');
    }

    // Check if environment is production
    const isProd = process.env.NODE_ENV === 'production';
    // The code that defines your stack goes here

    //DynamoDB Tables

    // Create a DynamoDB table to store form configurations and admin properties.
    // A configuration must be addressable by form ID alone, so `formId` is the
    // only key: the admin API and the form handler both look records up by it.
    const formTable = new aws_dynamodb.Table(this, formTableName, {
      tableName: formTableName,
      partitionKey: {
        name: 'formId',
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
    const dynamoLambdaLogGroup = new aws_logs.LogGroup(this, 'FormHandlerLambdaLogGroup', {
      retention: aws_logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const dynamoLambda = new NodejsFunction(this, lambdaName, {
      functionName: lambdaName,
      description: "Saves Form submissions to DynamoDB and send alert email",
      runtime: aws_lambda.Runtime.NODEJS_24_X,
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
      logGroup: dynamoLambdaLogGroup,
    });

    // Grant read/write permissions to our Lambda function for our DynamoDB tables.
    // The submissions table needs reads as well as writes because the one
    // submission per IP address check queries the formId-sourceIP index.
    table.grantReadWriteData(dynamoLambda);
    formTable.grantReadData(dynamoLambda);

    // Allow our Lambda function to send emails via SES
    const sesPolicy = new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      effect: iam.Effect.ALLOW,
      resources: ['*'], // You can restrict this to specific resources if needed
    });

    // Add the policy to our Lambda function's role
    dynamoLambda.addToRolePolicy(sesPolicy);

    // Define API Gateway integration with our main Lambda function
    const dynamoLambdaIntegration = new HttpLambdaIntegration(
      "dynamoLambdaIntegration",
      dynamoLambda
    );

    // Create a Lambda function for handling OPTIONS requests (CORS)
    let corsLambdaName = "form-handler-cors-lambda";
    const optionsLambdaLogGroup = new aws_logs.LogGroup(this, 'FormHandlerCorsLambdaLogGroup', {
      retention: aws_logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const optionsLambda = new NodejsFunction(this, corsLambdaName, {
      functionName: corsLambdaName,
      description: "Provides dynamic CORS header support",
      runtime: aws_lambda.Runtime.NODEJS_24_X,
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
      logGroup: optionsLambdaLogGroup,
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

    // Cognito user pool backing the admin interface. Sign up is closed: the only
    // way in is a user an administrator creates.
    const userPool = new cognito.UserPool(this, 'AdminUserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // The admin page signs in with the Cognito REST API from the browser, so the
    // client has no secret and needs the username/password auth flow.
    const userPoolClient = userPool.addClient('AdminWebClient', {
      generateSecret: false,
      authFlows: {
        userPassword: true,
      },
      // The admin page authenticates with USER_PASSWORD_AUTH via a direct REST call,
      // not a hosted-UI redirect, so the OAuth flows CDK enables by default (with a
      // placeholder https://example.com callback) are pure attack surface here.
      disableOAuth: true,
    });

    // Seed the first administrator. Cognito emails a temporary password; the
    // admin page completes the NEW_PASSWORD_REQUIRED challenge on first login.
    new cognito.CfnUserPoolUser(this, 'InitialAdminUser', {
      userPoolId: userPool.userPoolId,
      username: adminEmail,
      desiredDeliveryMediums: ['EMAIL'],
      userAttributes: [
        { name: 'email', value: adminEmail },
        { name: 'email_verified', value: 'true' },
      ],
    });

    // Create a Lambda function that serves both the static admin UI and the
    // form configuration JSON API
    const adminLambdaName = 'form-handler-admin-lambda';
    const adminLambdaLogGroup = new aws_logs.LogGroup(this, 'FormHandlerAdminLambdaLogGroup', {
      retention: aws_logs.RetentionDays.ONE_WEEK,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const adminLambda = new NodejsFunction(this, adminLambdaName, {
      functionName: adminLambdaName,
      description: "Serves the admin UI and the form configuration API",
      runtime: aws_lambda.Runtime.NODEJS_24_X,
      memorySize: memorySize,
      timeout: Duration.seconds(30),
      entry: "functions/admin/index.ts",
      handler: "handler",
      bundling: {
        minify: false,
        // The UI is plain HTML/CSS/JS with no build step. esbuild does not know
        // about it, so copy it next to the bundle; the handler reads it from
        // `path.join(__dirname, 'ui')` at runtime.
        //
        // `cp -r` is POSIX-only and runs on the host whenever esbuild bundles
        // locally. On a host without it (Windows outside WSL), CDK falls back
        // to bundling in Docker, where the command runs in the Linux image.
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `cp -r ${inputDir}/functions/admin/ui ${outputDir}/ui`,
          ],
        },
      },
      environment: {
        FORM_TABLE_NAME: formTableName,
        FORM_SUBMISSIONS_TABLE_NAME: formSubmissionTableName,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      },
      logGroup: adminLambdaLogGroup,
    });

    // The admin API creates, updates, and deletes form configurations, and
    // reads submissions (via the GSIs) for the reports feature.
    formTable.grantReadWriteData(adminLambda);
    table.grantReadData(adminLambda);

    const adminLambdaIntegration = new HttpLambdaIntegration(
      "adminLambdaIntegration",
      adminLambda
    );

    const adminApiName = "form-handler-admin";
    const adminApi = new apigwv2.HttpApi(this, adminApiName, {
      apiName: adminApiName,
      description: "Form Handler admin UI and API",
    });

    // The admin page itself must load before anyone can sign in, so the static
    // assets are public and only the JSON API is behind the JWT authorizer.
    const publicAuthorizer = new apigwv2.HttpNoneAuthorizer();
    for (const staticPath of ["/", "/admin.js", "/admin.css"]) {
      adminApi.addRoutes({
        path: staticPath,
        methods: [apigwv2.HttpMethod.GET],
        integration: adminLambdaIntegration,
        authorizer: publicAuthorizer,
      });
    }

    adminApi.addRoutes({
      path: "/api/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: adminLambdaIntegration,
      authorizer: new HttpUserPoolAuthorizer('AdminAuthorizer', userPool, {
        userPoolClients: [userPoolClient],
      }),
    });

    new CfnOutput(this, 'AdminUrl', {
      value: adminApi.url!,
    });

    new CfnOutput(this, 'AdminUserPoolId', {
      value: userPool.userPoolId,
    });

    new CfnOutput(this, 'AdminUserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });

  }
}
