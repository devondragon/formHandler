import * as fs from 'fs';
import * as path from 'path';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type {
  GetCommand as GetCommandType,
  PutCommand as PutCommandType,
  QueryCommand as QueryCommandType,
  ScanCommand as ScanCommandType,
} from '@aws-sdk/lib-dynamodb';
import type { SendEmailCommand as SendEmailCommandType } from '@aws-sdk/client-ses';
import type { AwsStub } from 'aws-sdk-client-mock';
import type { FormConfig } from '../functions/shared/form-config';

// Raw fixture is a REST-API-shaped sample event, not a true HTTP API (payload
// format 2.0) event. Per the plan, we don't edit the fixture — we build a
// real V2 event in this file, reusing the fields the handler actually reads
// (body, headers, requestContext.http.sourceIp) and filling in the rest of
// the V2 shape the type requires.
const rawEvent = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'events', 'simple-apigw-event.json'), 'utf-8')
);

function buildEvent(body: string = rawEvent.body): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /',
    rawPath: '/',
    rawQueryString: '',
    headers: rawEvent.headers,
    requestContext: {
      accountId: rawEvent.requestContext.accountId,
      apiId: rawEvent.requestContext.apiId,
      domainName: 'example.com',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/',
        protocol: 'HTTP/1.1',
        sourceIp: rawEvent.requestContext.http.sourceIp,
        userAgent: rawEvent.requestContext.http.userAgent,
      },
      requestId: rawEvent.requestContext.requestId,
      routeKey: 'POST /',
      stage: rawEvent.requestContext.stage,
      time: '09/Apr/2015:12:34:56 +0000',
      timeEpoch: 1428582896000,
    },
    body,
    isBase64Encoded: false,
  };
}

type HandlerModule = typeof import('../functions/form-handler');

let handlerModule: HandlerModule;
let dynamoMock: AwsStub<any, any, any>;
let documentMock: AwsStub<any, any, any>;
let sesMock: AwsStub<any, any, any>;
let PutCommand: typeof PutCommandType;
let GetCommand: typeof GetCommandType;
let QueryCommand: typeof QueryCommandType;
let ScanCommand: typeof ScanCommandType;
let SendEmailCommand: typeof SendEmailCommandType;

const existingFormConfig: FormConfig = {
  formId: '1234',
  formName: 'Contact Form',
  notificationEmail: 'owner@example.com',
  emailNotificationsEnabled: true,
  oneSubmissionPerIp: false,
  enabled: true,
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
};

const ENV_KEYS = ['FORM_TABLE_NAME', 'FORM_SUBMISSIONS_TABLE_NAME', 'EMAIL_FROM', 'EMAIL_TO'] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  process.env.FORM_TABLE_NAME = 'forms';
  process.env.FORM_SUBMISSIONS_TABLE_NAME = 'formSubmissions';
  process.env.EMAIL_FROM = 'test@test.com';
  process.env.EMAIL_TO = 'me@example.com';

  // The handler module caches `isFormConfigActive` at module scope after its
  // first invocation. Re-requiring it inside an isolated module registry for
  // every test (along with the SDK classes it depends on, captured into the
  // same closure) gives each test a fresh cache and mockable client
  // instances, without mismatching class identities between the handler and
  // the assertions below.
  jest.isolateModules(() => {
    const lib = require('@aws-sdk/lib-dynamodb');
    const ses = require('@aws-sdk/client-ses');
    const { mockClient } = require('aws-sdk-client-mock');

    PutCommand = lib.PutCommand;
    GetCommand = lib.GetCommand;
    QueryCommand = lib.QueryCommand;
    ScanCommand = lib.ScanCommand;
    SendEmailCommand = ses.SendEmailCommand;

    handlerModule = require('../functions/form-handler');

    dynamoMock = mockClient(handlerModule.dynamoClient);
    documentMock = mockClient(handlerModule.documentClient);
    sesMock = mockClient(handlerModule.sesClient);
  });

  // Default happy-path responses; individual tests override as needed.
  // `ScanCommand` with `Count: 0` is what `FormConfigRepository.hasAny()` sees
  // for the empty forms table, i.e. legacy mode.
  documentMock.on(ScanCommand).resolves({ Count: 0 });
  documentMock.on(PutCommand).resolves({});
  documentMock.on(GetCommand).resolves({});
  documentMock.on(QueryCommand).resolves({ Count: 0 });
  sesMock.on(SendEmailCommand).resolves({ MessageId: 'test-message-id' });
});

afterEach(() => {
  jest.restoreAllMocks();

  for (const key of ENV_KEYS) {
    const original = savedEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

test('returns 400 for an invalid JSON body', async () => {
  const event = buildEvent('not valid json');

  const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

  expect(result).toEqual({
    statusCode: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Invalid JSON in request body' }),
  });
});

test('accepts a submission when the forms table is empty', async () => {
  const event = buildEvent();

  const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

  expect(result.statusCode).toBe(200);

  const putCalls = documentMock.commandCalls(PutCommand);
  expect(putCalls).toHaveLength(1);
  const putInput = putCalls[0].args[0].input as Record<string, any>;
  expect(putInput.TableName).toBe('formSubmissions');
  expect(putInput.Item).toMatchObject({
    name: 'John Doe',
    email: 'john@doe.com',
    message: 'Hello, world!',
    company: 'Google',
    formId: '1234',
  });
  expect(putInput.Item.id).toEqual(expect.any(String));
  expect(putInput.Item.timestamp).toEqual(expect.any(String));
  expect(putInput.Item.sourceIP).toBe('127.0.0.1');

  const sesCalls = sesMock.commandCalls(SendEmailCommand);
  expect(sesCalls).toHaveLength(1);
  const sesInput = sesCalls[0].args[0].input as Record<string, any>;
  expect(sesInput.Source).toBe('test@test.com');
  expect(sesInput.Destination.ToAddresses).toEqual(['me@example.com']);

  expect(JSON.parse(result.body as string)).toEqual(putInput.Item);
});

test('rejects a submission missing formId when the forms table is populated', async () => {
  documentMock.on(ScanCommand).resolves({ Count: 5 });
  const body = JSON.stringify({ name: 'John Doe', email: 'john@doe.com' });
  const event = buildEvent(body);

  const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

  expect(result).toEqual({
    statusCode: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Form ID is missing' }),
  });
});

test('returns 500 when writing the submission to DynamoDB fails', async () => {
  documentMock.on(PutCommand).rejects(new Error('write failed'));
  const event = buildEvent();

  const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

  expect(result).toEqual({
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Error writing to DynamoDB' }),
  });
});

test('returns 500 when sending the alert email fails', async () => {
  sesMock.on(SendEmailCommand).rejects(new Error('send failed'));
  const event = buildEvent();

  const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

  expect(result).toEqual({
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Error sending email' }),
  });
});

test('accepts a submission with no X-Forwarded-For header', async () => {
  const rawHeaders = { ...rawEvent.headers };
  delete rawHeaders['X-Forwarded-For'];
  delete rawHeaders['x-forwarded-for'];
  const event = { ...buildEvent(), headers: rawHeaders };

  const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

  expect(result.statusCode).toBe(200);

  const putCalls = documentMock.commandCalls(PutCommand);
  expect(putCalls).toHaveLength(1);
  const putInput = putCalls[0].args[0].input as Record<string, any>;
  expect(putInput.Item.forwardedFor).toBeUndefined();
});

// aws-sdk-client-mock replaces `documentClient.send` outright, so the
// PutCommand marshalling middleware (the code path that actually throws on
// undefined values) never runs against the mock. The above test therefore
// can't reproduce the real 500 on its own; this assertion pins down the
// client configuration that fixes it.
test('DynamoDBDocumentClient is configured to drop undefined values when marshalling', () => {
  const translateConfig = (handlerModule.documentClient as any).config?.translateConfig;
  expect(translateConfig?.marshallOptions?.removeUndefinedValues).toBe(true);
});

test('escapes HTML in submitted field values before emailing them', async () => {
  const body = JSON.stringify({ formId: '1234', name: '<script>alert(1)</script>' });
  const event = buildEvent(body);

  await handlerModule.handler(event);

  const sesCalls = sesMock.commandCalls(SendEmailCommand);
  expect(sesCalls).toHaveLength(1);
  const htmlBody = (sesCalls[0].args[0].input as Record<string, any>).Message.Body.Html.Data as string;
  expect(htmlBody).toContain('&lt;script&gt;');
  expect(htmlBody).not.toContain('<script>');
});

describe('config mode enforcement', () => {
  beforeEach(() => {
    // Each test re-requires the handler in an isolated module registry, but
    // clear the module-scope cache explicitly so a test can never inherit a
    // previous test's config-mode answer.
    handlerModule.resetConfigCache();

    // At least one form config exists, so the handler switches to config mode.
    documentMock.on(ScanCommand).resolves({ Count: 1 });
  });

  test('returns 404 without a configuration lookup when formId is not a string', async () => {
    const event = buildEvent(JSON.stringify({ formId: 1234, name: 'John Doe' }));

    const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result).toEqual({
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Unknown form' }),
    });
    expect(documentMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(documentMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test('returns 404 when formId contains characters outside the allowed pattern', async () => {
    const event = buildEvent(JSON.stringify({ formId: 'has space', name: 'John Doe' }));

    const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result).toEqual({
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Unknown form' }),
    });
    expect(documentMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  test('returns 404 when the formId has no matching configuration', async () => {
    documentMock.on(GetCommand).resolves({});
    const event = buildEvent();

    const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result).toEqual({
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Unknown form' }),
    });
    expect(documentMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test('returns 403 when the matching form is disabled', async () => {
    documentMock.on(GetCommand).resolves({ Item: { ...existingFormConfig, enabled: false } });
    const event = buildEvent();

    const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result).toEqual({
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Form is disabled' }),
    });
    expect(documentMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test('returns 429 when oneSubmissionPerIp is on and a submission from the source IP already exists', async () => {
    documentMock
      .on(GetCommand)
      .resolves({ Item: { ...existingFormConfig, oneSubmissionPerIp: true } });
    documentMock.on(QueryCommand).resolves({ Count: 1 });
    const event = buildEvent();

    const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result).toEqual({
      statusCode: 429,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Only one submission per IP address is allowed for this form' }),
    });
    expect(documentMock.commandCalls(PutCommand)).toHaveLength(0);

    const queryCalls = documentMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    const queryInput = queryCalls[0].args[0].input as Record<string, any>;
    expect(queryInput.TableName).toBe('formSubmissions');
    expect(queryInput.IndexName).toBe('formId-sourceIP-index');
    expect(queryInput.KeyConditionExpression).toBe('formId = :formId AND sourceIP = :sourceIP');
    expect(queryInput.ExpressionAttributeValues).toEqual({ ':formId': '1234', ':sourceIP': '127.0.0.1' });
  });

  test('allows the submission when oneSubmissionPerIp is on and no prior submission exists for the IP', async () => {
    documentMock
      .on(GetCommand)
      .resolves({ Item: { ...existingFormConfig, oneSubmissionPerIp: true, emailNotificationsEnabled: false } });
    documentMock.on(QueryCommand).resolves({ Count: 0 });
    const event = buildEvent();

    const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(documentMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  test('skips the notification email and still returns 200 when emailNotificationsEnabled is off', async () => {
    documentMock
      .on(GetCommand)
      .resolves({ Item: { ...existingFormConfig, emailNotificationsEnabled: false } });
    const event = buildEvent();

    const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(sesMock.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  test('emails notificationEmail with a subject naming the form when emailNotificationsEnabled is on', async () => {
    documentMock.on(GetCommand).resolves({ Item: existingFormConfig });
    const event = buildEvent();

    const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const sesCalls = sesMock.commandCalls(SendEmailCommand);
    expect(sesCalls).toHaveLength(1);
    const sesInput = sesCalls[0].args[0].input as Record<string, any>;
    expect(sesInput.Destination.ToAddresses).toEqual(['owner@example.com']);
    expect(sesInput.Message.Subject.Data).toBe('New submission: Contact Form');
  });

  test('returns 500 when reading the form configuration fails', async () => {
    documentMock.on(GetCommand).rejects(new Error('read failed'));
    const event = buildEvent();

    const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result).toEqual({
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Error reading form configuration' }),
    });
  });

  test('returns 500 when the one-per-IP lookup fails', async () => {
    documentMock
      .on(GetCommand)
      .resolves({ Item: { ...existingFormConfig, oneSubmissionPerIp: true } });
    documentMock.on(QueryCommand).rejects(new Error('query failed'));
    const event = buildEvent();

    const result = (await handlerModule.handler(event)) as APIGatewayProxyStructuredResultV2;

    expect(result).toEqual({
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Error reading form configuration' }),
    });
  });

  test('caches the config-mode check for 60 seconds and does not re-issue the COUNT scan', async () => {
    documentMock.on(GetCommand).resolves({ Item: { ...existingFormConfig, emailNotificationsEnabled: false } });

    await handlerModule.handler(buildEvent());
    await handlerModule.handler(buildEvent());

    expect(documentMock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  test('keeps enforcing config mode when a re-check after the TTL fails', async () => {
    documentMock.on(GetCommand).resolves({ Item: { ...existingFormConfig, emailNotificationsEnabled: false } });

    // First call caches active: true.
    const first = (await handlerModule.handler(buildEvent())) as APIGatewayProxyStructuredResultV2;
    expect(first.statusCode).toBe(200);

    // Move past the 60 second TTL and make the re-check fail.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    documentMock.on(ScanCommand).rejects(new Error('scan failed'));
    documentMock.on(GetCommand).resolves({});

    const result = (await handlerModule.handler(buildEvent())) as APIGatewayProxyStructuredResultV2;

    // Still config mode: the unknown formId is rejected rather than accepted
    // as a legacy submission.
    expect(result).toEqual({
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Unknown form' }),
    });
    expect(documentMock.commandCalls(ScanCommand)).toHaveLength(2);
  });

  test('falls back to legacy mode when the very first config-mode check fails', async () => {
    documentMock.on(ScanCommand).rejects(new Error('scan failed'));

    const result = (await handlerModule.handler(buildEvent())) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(documentMock.commandCalls(PutCommand)).toHaveLength(1);
  });
});
