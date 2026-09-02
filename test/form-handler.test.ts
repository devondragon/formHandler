import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FormHandlerStack } from '../lib/form-handler-stack';

describe('FormHandlerStack', () => {
  const ENV_KEYS = ['FORM_TABLE_NAME', 'FORM_SUBMISSIONS_TABLE_NAME', 'EMAIL_FROM', 'EMAIL_TO'] as const;
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

  test('creates exactly two Lambda functions on the Node 24 runtime', () => {
    const template = buildTemplate();

    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      { Runtime: 'nodejs24.x' },
      2
    );
  });

  test('creates two DynamoDB tables', () => {
    const template = buildTemplate();

    template.resourceCountIs('AWS::DynamoDB::Table', 2);
  });

  test('creates two log groups with a one week retention and no explicit name', () => {
    const template = buildTemplate();

    template.resourcePropertiesCountIs(
      'AWS::Logs::LogGroup',
      { RetentionInDays: 7 },
      2
    );
    template.resourcePropertiesCountIs(
      'AWS::Logs::LogGroup',
      { LogGroupName: Match.anyValue() },
      0
    );
  });

  test('both Lambda functions reference a CDK-managed log group', () => {
    const template = buildTemplate();

    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      {
        LoggingConfig: Match.objectLike({
          LogGroup: Match.anyValue(),
        }),
      },
      2
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
});
