import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FormHandlerStack } from '../lib/form-handler-stack';

describe('FormHandlerStack', () => {
  const ENV_KEYS = [
    'FORM_TABLE_NAME',
    'FORM_SUBMISSIONS_TABLE_NAME',
    'EMAIL_FROM',
    'EMAIL_TO',
    'ADMIN_EMAIL',
  ] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeAll(() => {
    // Guard against dotenv reading a developer's .env file: set the
    // required environment variables explicitly before the stack is
    // instantiated anywhere in this suite.
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.FORM_TABLE_NAME = 'forms';
    process.env.FORM_SUBMISSIONS_TABLE_NAME = 'formSubmissions';
    process.env.EMAIL_FROM = 'test@test.com';
    process.env.EMAIL_TO = 'me@example.com';
    process.env.ADMIN_EMAIL = 'admin@example.com';
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const original = savedEnv[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  const buildTemplate = (): Template => {
    const app = new cdk.App();
    const stack = new FormHandlerStack(app, 'MyTestStack');
    return Template.fromStack(stack);
  };

  test('creates exactly three Lambda functions on the Node 24 runtime', () => {
    const template = buildTemplate();

    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      { Runtime: 'nodejs24.x' },
      3
    );
  });

  test('creates two DynamoDB tables', () => {
    const template = buildTemplate();

    template.resourceCountIs('AWS::DynamoDB::Table', 2);
  });

  test('creates three log groups with a one week retention and no explicit name', () => {
    const template = buildTemplate();

    template.resourcePropertiesCountIs(
      'AWS::Logs::LogGroup',
      { RetentionInDays: 7 },
      3
    );
    template.resourcePropertiesCountIs(
      'AWS::Logs::LogGroup',
      { LogGroupName: Match.anyValue() },
      0
    );
  });

  test('all three Lambda functions reference a CDK-managed log group', () => {
    const template = buildTemplate();

    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      {
        LoggingConfig: Match.objectLike({
          LogGroup: Match.anyValue(),
        }),
      },
      3
    );
  });

  test('creates POST and OPTIONS routes on the HTTP API', () => {
    const template = buildTemplate();

    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'OPTIONS /',
    });
  });

  test('the forms table is keyed by formId alone', () => {
    const template = buildTemplate();

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'forms',
      KeySchema: Match.exact([{ AttributeName: 'formId', KeyType: 'HASH' }]),
    });
  });

  test('creates a single admin user pool that only administrators can add users to', () => {
    const template = buildTemplate();

    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({
        AllowAdminCreateUserOnly: true,
      }),
    });
  });

  test('the admin user pool client enables the username/password auth flow and has no secret', () => {
    const template = buildTemplate();

    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
      GenerateSecret: false,
    });
  });

  test('creates the initial admin user from ADMIN_EMAIL', () => {
    const template = buildTemplate();

    template.hasResourceProperties('AWS::Cognito::UserPoolUser', {
      Username: 'admin@example.com',
      DesiredDeliveryMediums: ['EMAIL'],
      UserAttributes: Match.arrayWith([
        { Name: 'email', Value: 'admin@example.com' },
        { Name: 'email_verified', Value: 'true' },
      ]),
    });
  });

  test('serves the admin UI on unauthenticated routes', () => {
    const template = buildTemplate();

    for (const routeKey of ['GET /', 'GET /admin.js', 'GET /admin.css']) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
        AuthorizationType: 'NONE',
      });
    }
  });

  test('protects the admin JSON API with the JWT authorizer', () => {
    const template = buildTemplate();

    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'ANY /api/{proxy+}',
      AuthorizationType: 'JWT',
      AuthorizerId: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
    });
  });

  test('creates a second HTTP API for the admin interface', () => {
    const template = buildTemplate();

    template.resourceCountIs('AWS::ApiGatewayV2::Api', 2);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'form-handler-admin',
    });
  });

  test('outputs the admin URL and Cognito identifiers', () => {
    const template = buildTemplate();

    for (const outputName of ['AdminUrl', 'AdminUserPoolId', 'AdminUserPoolClientId', 'HttpApiUrl']) {
      template.hasOutput(outputName, {});
    }
  });

  test('throws when FORM_TABLE_NAME is unset', () => {
    const original = process.env.FORM_TABLE_NAME;
    delete process.env.FORM_TABLE_NAME;

    try {
      const app = new cdk.App();
      expect(() => new FormHandlerStack(app, 'MyTestStack')).toThrow();
    } finally {
      if (original === undefined) {
        delete process.env.FORM_TABLE_NAME;
      } else {
        process.env.FORM_TABLE_NAME = original;
      }
    }
  });

  test('throws when ADMIN_EMAIL is unset', () => {
    const original = process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_EMAIL;

    try {
      const app = new cdk.App();
      expect(() => new FormHandlerStack(app, 'MyTestStack')).toThrow(
        'Admin email is undefined. Make sure it is set in the environment variables.'
      );
    } finally {
      if (original === undefined) {
        delete process.env.ADMIN_EMAIL;
      } else {
        process.env.ADMIN_EMAIL = original;
      }
    }
  });
});
