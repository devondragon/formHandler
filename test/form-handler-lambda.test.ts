import * as fs from 'fs';
import * as path from 'path';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import type { PutCommand as PutCommandType, ScanCommand as ScanCommandType } from '@aws-sdk/lib-dynamodb';
import type { DescribeTableCommand as DescribeTableCommandType } from '@aws-sdk/client-dynamodb';
import type { SendEmailCommand as SendEmailCommandType } from '@aws-sdk/client-ses';
import type { AwsStub } from 'aws-sdk-client-mock';

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
let ScanCommand: typeof ScanCommandType;
let DescribeTableCommand: typeof DescribeTableCommandType;
let SendEmailCommand: typeof SendEmailCommandType;

beforeEach(() => {
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
    const ddb = require('@aws-sdk/client-dynamodb');
    const lib = require('@aws-sdk/lib-dynamodb');
    const ses = require('@aws-sdk/client-ses');
    const { mockClient } = require('aws-sdk-client-mock');

    DescribeTableCommand = ddb.DescribeTableCommand;
    PutCommand = lib.PutCommand;
    ScanCommand = lib.ScanCommand;
    SendEmailCommand = ses.SendEmailCommand;

    handlerModule = require('../functions/form-handler');

    dynamoMock = mockClient(handlerModule.dynamoClient);
    documentMock = mockClient(handlerModule.documentClient);
    sesMock = mockClient(handlerModule.sesClient);
  });

  // Default happy-path responses; individual tests override as needed.
  dynamoMock.on(DescribeTableCommand).resolves({ Table: { TableName: 'forms' } });
  documentMock.on(ScanCommand).resolves({ Count: 0 });
  documentMock.on(PutCommand).resolves({});
  sesMock.on(SendEmailCommand).resolves({ MessageId: 'test-message-id' });
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
