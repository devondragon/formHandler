import * as fs from 'fs';
import * as path from 'path';
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

  // Synthesizing the stack is the slow part of this suite, so it happens once
  // and every assertion test reads the same template and cloud assembly. The
  // "throws when ... is unset" tests below still build their own stack, since
  // they need a different environment.
  let template: Template;
  let assemblyDir: string;

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

    const app = new cdk.App();
    const stack = new FormHandlerStack(app, 'MyTestStack');
    template = Template.fromStack(stack);
    assemblyDir = app.synth().directory;
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

  test('creates exactly three Lambda functions on the Node 24 runtime', () => {
    template.resourcePropertiesCountIs(
      'AWS::Lambda::Function',
      { Runtime: 'nodejs24.x' },
      3
    );
  });

  test('creates two DynamoDB tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 2);
  });

  test('creates three log groups with a one week retention and no explicit name', () => {
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
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'OPTIONS /',
    });
  });

  test('the forms table is keyed by formId alone', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'forms',
      KeySchema: Match.exact([{ AttributeName: 'formId', KeyType: 'HASH' }]),
    });
  });

  test('grants the admin Lambda dynamodb:Query on the submissions table and its GSIs', () => {
    template.hasResourceProperties(
      'AWS::IAM::Policy',
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['dynamodb:Query']),
              Resource: Match.arrayWith([
                Match.objectLike({
                  'Fn::Join': ['', Match.arrayWith(['/index/*'])],
                }),
              ]),
            }),
          ]),
        }),
      })
    );
  });

  test('creates a single admin user pool that only administrators can add users to', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: Match.objectLike({
        AllowAdminCreateUserOnly: true,
      }),
    });
  });

  test('the admin user pool client enables the username/password auth flow and has no secret', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_PASSWORD_AUTH']),
      GenerateSecret: false,
    });
  });

  test('the admin user pool client has OAuth disabled (no hosted-UI flows or callback)', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlowsUserPoolClient: Match.anyValue(),
    });
    const clients = template.findResources('AWS::Cognito::UserPoolClient');
    for (const client of Object.values(clients)) {
      const props = (client as { Properties?: Record<string, unknown> }).Properties ?? {};
      expect(props.AllowedOAuthFlows).toBeUndefined();
      expect(props.AllowedOAuthFlowsUserPoolClient).toBe(false);
    }
  });

  test('creates the initial admin user from ADMIN_EMAIL', () => {
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
    for (const routeKey of ['GET /', 'GET /admin.js', 'GET /admin.css']) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: routeKey,
        AuthorizationType: 'NONE',
      });
    }
  });

  test('protects the admin JSON API with the JWT authorizer', () => {
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
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 2);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'form-handler-admin',
    });
  });

  test('bundles the admin UI files into the admin Lambda asset', () => {
    const outdir = assemblyDir;

    // esbuild bundling copies functions/admin/ui/* to <outputDir>/ui via
    // afterBundling; the asset directory itself is named asset.<hash> in the
    // synthesized cloud assembly, so scan for it rather than assuming a name.
    const assetDirs = fs
      .readdirSync(outdir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('asset.'));

    const matches = assetDirs.filter((entry) =>
      fs.existsSync(path.join(outdir, entry.name, 'ui', 'index.html'))
    );

    expect(matches).toHaveLength(1);
  });

  test('outputs the admin URL and Cognito identifiers', () => {
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
