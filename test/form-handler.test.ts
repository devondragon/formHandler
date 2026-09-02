import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { FormHandlerStack } from '../lib/form-handler-stack';

describe('FormHandlerStack', () => {
  beforeAll(() => {
    // Guard against dotenv reading a developer's .env file: set the
    // required environment variables explicitly before the stack is
    // instantiated anywhere in this suite.
    process.env.FORM_TABLE_NAME = 'forms';
    process.env.FORM_SUBMISSIONS_TABLE_NAME = 'formSubmissions';
    process.env.EMAIL_FROM = 'test@test.com';
    process.env.EMAIL_TO = 'me@example.com';
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
      process.env.FORM_TABLE_NAME = original;
    }
  });
});
