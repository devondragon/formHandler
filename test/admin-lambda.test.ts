import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import * as adminModule from '../functions/admin';

const ddbMock = mockClient(adminModule.documentClient);

/**
 * Builds an HTTP API payload v2 event. `authorized` mirrors what API Gateway does:
 * `requestContext.authorizer.jwt` is present only when a JWT authorizer accepted
 * the request, so passing `false` simulates an `/api` route reached without one.
 * `queryStringParameters` mirrors API Gateway's parsed query string.
 */
function makeEvent(
  method: string,
  path: string,
  body?: string,
  isBase64Encoded = false,
  authorized = true,
  queryStringParameters?: Record<string, string>
): APIGatewayProxyEventV2 {
  const authorizerContext = authorized
    ? { authorizer: { jwt: { claims: { sub: 'test' }, scopes: null } } }
    : {};

  const requestContext = {
    accountId: '123456789012',
    apiId: 'admin-api',
    domainName: 'admin.example.com',
    domainPrefix: 'admin',
    http: {
      method,
      path,
      protocol: 'HTTP/1.1',
      sourceIp: '127.0.0.1',
      userAgent: 'jest',
    },
    requestId: 'req-1',
    routeKey: `${method} ${path}`,
    stage: '$default',
    time: '09/Apr/2015:12:34:56 +0000',
    timeEpoch: 1428582896000,
    ...authorizerContext,
  };

  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: queryStringParameters
      ? new URLSearchParams(queryStringParameters).toString()
      : '',
    headers: {},
    queryStringParameters,
    requestContext,
    body,
    isBase64Encoded,
  };
}

const existingForm = {
  formId: 'contact-us',
  formName: 'Contact Us',
  notificationEmail: 'owner@example.com',
  emailNotificationsEnabled: true,
  oneSubmissionPerIp: false,
  enabled: true,
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T00:00:00.000Z',
};

const ENV_KEYS = [
  'FORM_TABLE_NAME',
  'USER_POOL_ID',
  'USER_POOL_CLIENT_ID',
  'AWS_REGION',
  'COGNITO_REGION',
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }

  ddbMock.reset();
  process.env.FORM_TABLE_NAME = 'forms';
  process.env.FORM_SUBMISSIONS_TABLE_NAME = 'formSubmissions';
  process.env.USER_POOL_ID = 'us-east-1_ABC123';
  process.env.USER_POOL_CLIENT_ID = 'client123abc';
  process.env.AWS_REGION = 'us-east-1';
  delete process.env.COGNITO_REGION;
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

const EXPECTED_CONFIG_ATTRIBUTE =
  'data-config=\'{&quot;region&quot;:&quot;us-east-1&quot;,' +
  '&quot;userPoolId&quot;:&quot;us-east-1_ABC123&quot;,' +
  '&quot;clientId&quot;:&quot;client123abc&quot;}\'';

const EXPECTED_CSP =
  "default-src 'self'; " +
  'connect-src \'self\' https://cognito-idp.us-east-1.amazonaws.com; ' +
  "img-src 'self' data:; " +
  "style-src 'self'; " +
  "script-src 'self'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none'; " +
  "form-action 'self'";

describe('static UI serving', () => {
  test('GET / returns 200 HTML carrying the Cognito config as an escaped data attribute', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('text/html; charset=utf-8');
    expect(result.headers?.['Cache-Control']).toBe('no-store');
    expect(result.body).toContain(EXPECTED_CONFIG_ATTRIBUTE);
    // No template placeholder of any kind survives into the served page.
    expect(result.body).not.toMatch(/__[A-Z_]+__/);
  });

  test('GET / sets the frame, sniffing, and content security policy headers', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.headers?.['X-Frame-Options']).toBe('DENY');
    expect(result.headers?.['X-Content-Type-Options']).toBe('nosniff');
    expect(result.headers?.['Content-Security-Policy']).toBe(EXPECTED_CSP);
  });

  test('the served page contains no inline script or event handler the CSP would block', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/')
    )) as APIGatewayProxyStructuredResultV2;

    const body = result.body as string;
    expect(body).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(body).not.toMatch(/\son[a-z]+\s*=/i);
    expect(body).not.toMatch(/\sstyle\s*=/i);
  });

  test('config values containing quotes cannot break out of the data attribute', async () => {
    const hostile = 'abc\'"><script>alert(1)</script>&';
    process.env.USER_POOL_CLIENT_ID = hostile;

    const result = (await adminModule.handler(
      makeEvent('GET', '/')
    )) as APIGatewayProxyStructuredResultV2;

    const body = result.body as string;
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).not.toContain(hostile);

    // What the browser will do: take the attribute, decode the character
    // references, and JSON.parse the result.
    const attribute = /data-config='([^']*)'/.exec(body);
    expect(attribute).not.toBeNull();
    const decoded = (attribute as RegExpExecArray)[1]
      .split('&#39;').join("'")
      .split('&quot;').join('"')
      .split('&gt;').join('>')
      .split('&lt;').join('<')
      .split('&amp;').join('&');
    expect(JSON.parse(decoded)).toEqual({
      region: 'us-east-1',
      userPoolId: 'us-east-1_ABC123',
      clientId: hostile,
    });
  });

  test('GET /index.html serves the same page as GET /', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/index.html')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('text/html; charset=utf-8');
    expect(result.headers?.['Cache-Control']).toBe('no-store');
    expect(result.headers?.['Content-Security-Policy']).toBe(EXPECTED_CSP);
    expect(result.body).toContain(EXPECTED_CONFIG_ATTRIBUTE);
  });

  test('GET /admin.js returns 200 with application/javascript content type', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/admin.js')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('application/javascript; charset=utf-8');
    expect(result.headers?.['Cache-Control']).toBe('no-store');
    expect(result.headers?.['X-Content-Type-Options']).toBe('nosniff');
  });

  test('GET /admin.css returns 200 with text/css content type', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/admin.css')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('text/css; charset=utf-8');
    expect(result.headers?.['Cache-Control']).toBe('no-store');
    expect(result.headers?.['X-Content-Type-Options']).toBe('nosniff');
  });
});

describe('GET /api/forms', () => {
  test('returns the sorted list of forms', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { ...existingForm, formId: 'zebra-form' },
        { ...existingForm, formId: 'apple-form' },
      ],
    });

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('application/json');
    // Form configuration is per-session data; no intermediary may cache it.
    expect(result.headers?.['Cache-Control']).toBe('no-store');
    const parsed = JSON.parse(result.body as string);
    expect(parsed.forms.map((f: any) => f.formId)).toEqual(['apple-form', 'zebra-form']);
  });
});

describe('GET /api/forms/{formId}', () => {
  test('returns 404 with a message when the form is missing', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/does-not-exist')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body as string)).toEqual({ message: 'Form not found' });
  });

  test('returns the form when it exists', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingForm });

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual(existingForm);
  });
});

describe('PUT /api/forms/{formId}', () => {
  test('invalid body returns 400 with an errors array', async () => {
    const result = (await adminModule.handler(
      makeEvent('PUT', '/api/forms/contact-us', JSON.stringify({}))
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    const parsed = JSON.parse(result.body as string);
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  test('body formId mismatched with the path returns 400', async () => {
    const body = JSON.stringify({
      formId: 'other-form',
      formName: 'Contact Us',
      emailNotificationsEnabled: false,
      oneSubmissionPerIp: false,
      enabled: true,
    });

    const result = (await adminModule.handler(
      makeEvent('PUT', '/api/forms/contact-us', body)
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    const parsed = JSON.parse(result.body as string);
    expect(parsed.errors).toContain('formId in body does not match URL');
  });

  test('invalid JSON body returns 400', async () => {
    const result = (await adminModule.handler(
      makeEvent('PUT', '/api/forms/contact-us', 'not valid json')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body as string)).toEqual({ message: 'Invalid JSON in request body' });
  });

  test('a valid body creates the form and returns 200 with createdAt/updatedAt', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const body = JSON.stringify({
      formName: 'Contact Us',
      notificationEmail: 'owner@example.com',
      emailNotificationsEnabled: true,
      oneSubmissionPerIp: false,
      enabled: true,
    });

    const result = (await adminModule.handler(
      makeEvent('PUT', '/api/forms/contact-us', body)
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body as string);
    expect(parsed.formId).toBe('contact-us');
    expect(parsed.createdAt).toEqual(expect.any(String));
    expect(parsed.updatedAt).toEqual(expect.any(String));

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.TableName).toBe('forms');
  });

  test('a base64-encoded body is decoded before parsing', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const body = JSON.stringify({
      formName: 'Contact Us',
      notificationEmail: 'owner@example.com',
      emailNotificationsEnabled: true,
      oneSubmissionPerIp: false,
      enabled: true,
    });
    const encodedBody = Buffer.from(body, 'utf8').toString('base64');

    const result = (await adminModule.handler(
      makeEvent('PUT', '/api/forms/contact-us', encodedBody, true)
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body as string);
    expect(parsed.formId).toBe('contact-us');
    expect(parsed.formName).toBe('Contact Us');
  });
});

describe('DELETE /api/forms/{formId}', () => {
  test('returns 204 and is idempotent', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    const result = (await adminModule.handler(
      makeEvent('DELETE', '/api/forms/contact-us')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(204);

    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.TableName).toBe('forms');
  });
});

describe('GET /api/forms/{formId}/submissions', () => {
  function submissionItem(id: string, timestamp: string, extra: Record<string, unknown> = {}) {
    return { id, timestamp, formId: 'contact-us', sourceIP: '1.2.3.4', ...extra };
  }

  test('returns submissions and a nextCursor when more pages remain', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingForm });
    ddbMock.on(QueryCommand).resolves({
      Items: [submissionItem('1', '2026-01-02T00:00:00.000Z', { name: 'Jane' })],
      LastEvaluatedKey: { id: '1', timestamp: '2026-01-02T00:00:00.000Z', formId: 'contact-us' },
    });

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions', undefined, false, true, { limit: '1' })
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body as string);
    expect(parsed.submissions).toHaveLength(1);
    expect(parsed.submissions[0]).toMatchObject({ id: '1' });
    expect(parsed.nextCursor).toEqual(expect.any(String));
  });

  test('returns no nextCursor when the index is exhausted', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingForm });
    ddbMock.on(QueryCommand).resolves({
      Items: [submissionItem('1', '2026-01-02T00:00:00.000Z')],
    });

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const parsed = JSON.parse(result.body as string);
    expect(parsed.nextCursor).toBeUndefined();
  });

  test('limit outside 1..200 returns 400', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions', undefined, false, true, { limit: '0' })
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body as string)).toEqual({ message: 'limit must be between 1 and 200' });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test('limit that is not an integer returns 400', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions', undefined, false, true, { limit: 'abc' })
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body as string)).toEqual({ message: 'limit must be between 1 and 200' });
  });

  test('a malformed from date returns 400', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions', undefined, false, true, { from: 'not-a-date' })
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body as string)).toEqual({
      message: 'from and to must be ISO 8601 dates',
    });
  });

  test('a malformed cursor returns 400', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingForm });

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions', undefined, false, true, {
        cursor: 'not-a-valid-cursor!!!',
      })
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body as string)).toEqual({ message: 'Invalid cursor' });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test('an unknown form returns 404', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/does-not-exist/submissions')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body as string)).toEqual({ message: 'Form not found' });
  });

  test('a date-only "to" is treated as inclusive of that day in the key condition', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingForm });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions', undefined, false, true, {
        to: '2026-01-31',
      })
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues).toMatchObject({ ':to': '2026-01-31T23:59:59.999Z' });
  });
});

describe('GET /api/forms/{formId}/submissions/export', () => {
  function submissionItem(id: string, timestamp: string, extra: Record<string, unknown> = {}) {
    return { id, timestamp, formId: 'contact-us', sourceIP: '1.2.3.4', forwardedFor: '', ...extra };
  }

  test('CSV export (default format) returns the right headers and body, with no X-Truncated header', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingForm });
    ddbMock.on(QueryCommand).resolves({
      Items: [submissionItem('1', '2026-01-02T00:00:00.000Z', { name: 'Jane' })],
    });

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions/export')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(result.headers?.['Content-Disposition']).toBe(
      'attachment; filename="contact-us-submissions.csv"'
    );
    expect(result.headers?.['X-Truncated']).toBeUndefined();
    expect(result.body).toBe(
      'id,timestamp,sourceIP,forwardedFor,formId,name\r\n' +
        '1,2026-01-02T00:00:00.000Z,1.2.3.4,,contact-us,Jane\r\n'
    );
  });

  test('JSON export returns the right headers and body', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingForm });
    ddbMock.on(QueryCommand).resolves({
      Items: [submissionItem('1', '2026-01-02T00:00:00.000Z', { name: 'Jane' })],
    });

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions/export', undefined, false, true, {
        format: 'json',
      })
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(result.headers?.['Content-Disposition']).toBe(
      'attachment; filename="contact-us-submissions.json"'
    );
    expect(JSON.parse(result.body as string)).toEqual({
      submissions: [submissionItem('1', '2026-01-02T00:00:00.000Z', { name: 'Jane' })],
    });
  });

  test('sets X-Truncated: true when the 10000-row export cap is hit', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingForm });
    // One page carrying more than EXPORT_MAX_ROWS (10000) items forces
    // queryAll to stop mid-page and report truncated: true.
    const items = Array.from({ length: 10001 }, (_, i) =>
      submissionItem(String(i), '2026-01-02T00:00:00.000Z')
    );
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions/export')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['X-Truncated']).toBe('true');
    const parsedRows = (result.body as string).split('\r\n').slice(1, -1);
    expect(parsedRows).toHaveLength(10000);
  });

  test.each([
    ['csv', 'text/csv; charset=utf-8'],
    ['json', 'application/json'],
  ])('the %s export is uncacheable and not sniffable', async (format, contentType) => {
    ddbMock.on(GetCommand).resolves({ Item: existingForm });
    ddbMock.on(QueryCommand).resolves({ Items: [submissionItem('1', '2026-01-02T00:00:00.000Z')] });

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions/export', undefined, false, true, {
        format,
      })
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.headers?.['Content-Type']).toBe(contentType);
    expect(result.headers?.['Cache-Control']).toBe('no-store');
    expect(result.headers?.['X-Content-Type-Options']).toBe('nosniff');
  });

  describe('the 5 MB byte cap', () => {
    const EXPORT_MAX_BYTES = 5 * 1024 * 1024;

    /** Eight rows of roughly 1 MiB each: the byte cap trips well before 10,000 rows. */
    function oversizedItems() {
      const blob = 'a'.repeat(1024 * 1024);
      return Array.from({ length: 8 }, (_, i) =>
        submissionItem(String(i), '2026-01-02T00:00:00.000Z', { blob })
      );
    }

    test('CSV: drops rows past the cap, sets X-Truncated, and stays under the cap', async () => {
      ddbMock.on(GetCommand).resolves({ Item: existingForm });
      ddbMock.on(QueryCommand).resolves({ Items: oversizedItems() });

      const result = (await adminModule.handler(
        makeEvent('GET', '/api/forms/contact-us/submissions/export')
      )) as APIGatewayProxyStructuredResultV2;

      expect(result.statusCode).toBe(200);
      expect(result.headers?.['X-Truncated']).toBe('true');
      const body = result.body as string;
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(EXPORT_MAX_BYTES);
      const rows = body.split('\r\n').slice(1, -1);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(8);
    });

    test('JSON: drops rows past the cap, sets X-Truncated, and stays under the cap', async () => {
      ddbMock.on(GetCommand).resolves({ Item: existingForm });
      ddbMock.on(QueryCommand).resolves({ Items: oversizedItems() });

      const result = (await adminModule.handler(
        makeEvent('GET', '/api/forms/contact-us/submissions/export', undefined, false, true, {
          format: 'json',
        })
      )) as APIGatewayProxyStructuredResultV2;

      expect(result.statusCode).toBe(200);
      expect(result.headers?.['X-Truncated']).toBe('true');
      const body = result.body as string;
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(EXPORT_MAX_BYTES);
      const parsed = JSON.parse(body);
      expect(parsed.submissions.length).toBeGreaterThan(0);
      expect(parsed.submissions.length).toBeLessThan(8);
    });
  });

  test('an unsupported format returns 400', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/contact-us/submissions/export', undefined, false, true, {
        format: 'xml',
      })
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body as string)).toEqual({ message: 'format must be csv or json' });
  });

  test('an unknown form returns 404', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/does-not-exist/submissions/export')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body as string)).toEqual({ message: 'Form not found' });
  });
});

describe('authorization', () => {
  test('an /api request without the JWT authorizer context returns 401 and issues no DynamoDB command', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms', undefined, false, false)
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(401);
    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(result.body as string)).toEqual({ message: 'Unauthorized' });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  test('static routes are still served without the JWT authorizer context', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/', undefined, false, false)
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(200);
  });
});

describe('routing errors', () => {
  test('unknown /api path returns 404', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/api/unknown')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(404);
    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(result.body as string)).toEqual({ message: 'Not found' });
  });

  test('an invalid percent-encoded form ID returns 404', async () => {
    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms/%zz')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(404);
    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(result.body as string)).toEqual({ message: 'Form not found' });
  });

  test('unsupported method on /api/forms returns 405', async () => {
    const result = (await adminModule.handler(
      makeEvent('POST', '/api/forms')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(405);
    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(result.body as string)).toEqual({ message: 'Method not allowed' });
  });

  test('DynamoDB rejection returns 500', async () => {
    ddbMock.on(ScanCommand).rejects(new Error('boom'));
    const consoleErrorSpy = jest.spyOn(console, 'error');

    const result = (await adminModule.handler(
      makeEvent('GET', '/api/forms')
    )) as APIGatewayProxyStructuredResultV2;

    expect(result.statusCode).toBe(500);
    expect(result.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(result.body as string)).toEqual({ message: 'Internal error' });
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});
