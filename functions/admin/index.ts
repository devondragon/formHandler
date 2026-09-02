import * as fs from 'fs';
import * as path from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { FormConfigRepository, validateFormConfig } from '../shared/form-config';
import { decodeCursor, Submission, SubmissionRepository, toCsv } from '../shared/submissions';

// create AWS SDK clients (module scope, exported for mocking in tests)
export const dynamoClient = new DynamoDBClient();
export const documentClient = DynamoDBDocumentClient.from(dynamoClient);

const UI_DIR = path.join(__dirname, 'ui');
const uiFileCache = new Map<string, string>();

/** Reads a file from `functions/admin/ui`, caching its contents after the first read. */
function readUiFile(name: string): string {
  const cached = uiFileCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const content = fs.readFileSync(path.join(UI_DIR, name), 'utf8');
  uiFileCache.set(name, content);
  return content;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

function serveStatic(name: string, contentType: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    body: readUiFile(name),
  };
}

/**
 * Escapes a value for use inside an HTML attribute. Both quote characters are
 * escaped, so the result is safe in a single- or double-quoted attribute and a
 * config value containing a quote cannot close the attribute and inject markup.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

/**
 * Serves `ui/index.html`, passing the Cognito config to the page as a data
 * attribute on the script tag. The page carries no inline script, so it can be
 * served under a `script-src 'self'` content security policy.
 */
function serveIndexHtml(): APIGatewayProxyResultV2 {
  const region = process.env.AWS_REGION || process.env.COGNITO_REGION || '';
  const config = {
    region,
    userPoolId: process.env.USER_POOL_ID || '',
    clientId: process.env.USER_POOL_CLIENT_ID || '',
  };

  const html = readUiFile('index.html')
    .split('__ADMIN_CONFIG__')
    .join(escapeHtmlAttribute(JSON.stringify(config)));

  // `connect-src` has to name the regional Cognito endpoint that admin.js posts
  // the InitiateAuth/RespondToAuthChallenge calls to.
  const csp = [
    "default-src 'self'",
    `connect-src 'self' https://cognito-idp.${region}.amazonaws.com`,
    "img-src 'self' data:",
    "style-src 'self'",
    "script-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': csp,
    },
    body: html,
  };
}

function getRepository(): FormConfigRepository {
  const tableName = process.env.FORM_TABLE_NAME;
  if (!tableName) {
    throw new Error('FORM_TABLE_NAME is not set');
  }
  return new FormConfigRepository(documentClient, tableName);
}

function getSubmissionRepository(): SubmissionRepository {
  const tableName = process.env.FORM_SUBMISSIONS_TABLE_NAME;
  if (!tableName) {
    throw new Error('FORM_SUBMISSIONS_TABLE_NAME is not set');
  }
  return new SubmissionRepository(documentClient, tableName);
}

async function listForms(): Promise<APIGatewayProxyResultV2> {
  const forms = await getRepository().list();
  return json(200, { forms });
}

async function getForm(formId: string): Promise<APIGatewayProxyResultV2> {
  const form = await getRepository().get(formId);
  if (!form) {
    return json(404, { message: 'Form not found' });
  }
  return json(200, form);
}

async function putForm(formId: string, rawBody: string | undefined): Promise<APIGatewayProxyResultV2> {
  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (err) {
    console.warn('Invalid JSON in PUT /api/forms request body', err);
    return json(400, { message: 'Invalid JSON in request body' });
  }

  const result = validateFormConfig(body, formId);
  if ('errors' in result) {
    return json(400, { message: 'Validation failed', errors: result.errors });
  }

  const saved = await getRepository().put(result.value);
  return json(200, saved);
}

async function deleteForm(formId: string): Promise<APIGatewayProxyResultV2> {
  await getRepository().delete(formId);
  return { statusCode: 204 };
}

const DEFAULT_SUBMISSIONS_LIMIT = 50;
const MIN_SUBMISSIONS_LIMIT = 1;
const MAX_SUBMISSIONS_LIMIT = 200;
const EXPORT_MAX_ROWS = 10000;
const EXPORT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Serializes the longest prefix of `rows` whose body fits in
 * `EXPORT_MAX_BYTES`. 10,000 rows of submitted text can be far larger than a
 * Lambda response is allowed to be, and an oversized response fails as a 500
 * with no partial data, so an export that would exceed the cap comes back
 * short instead. Both serializers grow monotonically with the row count, so a
 * binary search over the prefix length finds the cut in a handful of passes.
 */
function serializeWithinByteCap(
  rows: Submission[],
  serialize: (rows: Submission[]) => string
): { body: string; capped: boolean } {
  const full = serialize(rows);
  if (Buffer.byteLength(full, 'utf8') <= EXPORT_MAX_BYTES) {
    return { body: full, capped: false };
  }

  // `low` is the largest row count known to fit, `high` the smallest known not to.
  let low = 0;
  let high = rows.length;
  let body = serialize([]);
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const candidate = serialize(rows.slice(0, mid));
    if (Buffer.byteLength(candidate, 'utf8') <= EXPORT_MAX_BYTES) {
      low = mid;
      body = candidate;
    } else {
      high = mid;
    }
  }
  return { body, capped: true };
}

type QueryStringParams = Record<string, string | undefined> | undefined;
interface ValidationError {
  message: string;
}
interface DateBounds {
  from?: string;
  to?: string;
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidationError(value: unknown): value is ValidationError {
  return typeof value === 'object' && value !== null && 'message' in value;
}

/** `limit` defaults to 50 and must be an integer in `1..200`. */
function parseSubmissionsLimit(qs: QueryStringParams): number | ValidationError {
  const raw = qs?.limit;
  if (raw === undefined) {
    return DEFAULT_SUBMISSIONS_LIMIT;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_SUBMISSIONS_LIMIT || value > MAX_SUBMISSIONS_LIMIT) {
    return { message: 'limit must be between 1 and 200' };
  }
  return value;
}

/**
 * Validates `from`/`to` as ISO 8601 date or date-time strings (anything
 * `Date.parse` accepts). A date-only `to` (YYYY-MM-DD) is treated as
 * inclusive of that day by appending the end-of-day time.
 */
function parseDateBounds(qs: QueryStringParams): DateBounds | ValidationError {
  const { from, to } = qs ?? {};
  const fromValid = from === undefined || !Number.isNaN(Date.parse(from));
  const toValid = to === undefined || !Number.isNaN(Date.parse(to));
  if (!fromValid || !toValid) {
    return { message: 'from and to must be ISO 8601 dates' };
  }
  return {
    from,
    to: to !== undefined && DATE_ONLY_PATTERN.test(to) ? `${to}T23:59:59.999Z` : to,
  };
}

async function listSubmissions(formId: string, qs: QueryStringParams): Promise<APIGatewayProxyResultV2> {
  const limit = parseSubmissionsLimit(qs);
  if (isValidationError(limit)) {
    return json(400, limit);
  }

  const dateBounds = parseDateBounds(qs);
  if (isValidationError(dateBounds)) {
    return json(400, dateBounds);
  }

  const cursor = qs?.cursor;
  if (cursor !== undefined) {
    try {
      decodeCursor(cursor);
    } catch (err) {
      console.warn('Invalid submissions pagination cursor', err);
      return json(400, { message: 'Invalid cursor' });
    }
  }

  const form = await getRepository().get(formId);
  if (!form) {
    return json(404, { message: 'Form not found' });
  }

  const result = await getSubmissionRepository().query({
    formId,
    from: dateBounds.from,
    to: dateBounds.to,
    q: qs?.q,
    limit,
    cursor,
  });
  return json(200, result);
}

async function exportSubmissions(formId: string, qs: QueryStringParams): Promise<APIGatewayProxyResultV2> {
  const format = qs?.format ?? 'csv';
  if (format !== 'csv' && format !== 'json') {
    return json(400, { message: 'format must be csv or json' });
  }

  const dateBounds = parseDateBounds(qs);
  if (isValidationError(dateBounds)) {
    return json(400, dateBounds);
  }

  const form = await getRepository().get(formId);
  if (!form) {
    return json(404, { message: 'Form not found' });
  }

  const { submissions, truncated } = await getSubmissionRepository().queryAll({
    formId,
    from: dateBounds.from,
    to: dateBounds.to,
    q: qs?.q,
    maxRows: EXPORT_MAX_ROWS,
  });

  const serialized =
    format === 'json'
      ? serializeWithinByteCap(submissions, (rows) => JSON.stringify({ submissions: rows }))
      : serializeWithinByteCap(submissions, toCsv);

  const truncatedHeader: Record<string, string> =
    truncated || serialized.capped ? { 'X-Truncated': 'true' } : {};

  return {
    statusCode: 200,
    headers: {
      'Content-Type': format === 'json' ? 'application/json' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${formId}-submissions.${format}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...truncatedHeader,
    },
    body: serialized.body,
  };
}

/** API Gateway base64-encodes the body (e.g. for some client/proxy combinations); decode it before parsing. */
function getRequestBody(event: APIGatewayProxyEventV2): string | undefined {
  if (event.body === undefined) {
    return undefined;
  }
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

const FORM_ITEM_PATH = /^\/api\/forms\/([^/]+)$/;
const FORM_SUBMISSIONS_PATH = /^\/api\/forms\/([^/]+)\/submissions$/;
const FORM_SUBMISSIONS_EXPORT_PATH = /^\/api\/forms\/([^/]+)\/submissions\/export$/;

/** Percent-decodes a form ID path segment, returning `undefined` on malformed input. */
function decodeFormId(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    console.warn('Invalid percent-encoding in form ID path segment', err);
    return undefined;
  }
}

/**
 * API Gateway populates `requestContext.authorizer.jwt` only when a JWT authorizer
 * accepted the request. The authorizer on the `ANY /api/{proxy+}` route is the real
 * authentication boundary; this check is defense in depth so a route that was wired
 * up without an authorizer cannot reach the data.
 */
function hasJwtClaims(event: APIGatewayProxyEventV2): boolean {
  const { authorizer } = event.requestContext as {
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
  return authorizer?.jwt?.claims !== undefined;
}

async function route(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const rawPath = event.rawPath;

  if (rawPath.startsWith('/api/') && !hasJwtClaims(event)) {
    console.warn('Rejecting an /api request that carries no JWT authorizer claims', rawPath);
    return json(401, { message: 'Unauthorized' });
  }

  if (rawPath === '/' || rawPath === '/index.html') {
    return method === 'GET' ? serveIndexHtml() : json(405, { message: 'Method not allowed' });
  }

  if (rawPath === '/admin.js') {
    return method === 'GET'
      ? serveStatic('admin.js', 'application/javascript; charset=utf-8')
      : json(405, { message: 'Method not allowed' });
  }

  if (rawPath === '/admin.css') {
    return method === 'GET'
      ? serveStatic('admin.css', 'text/css; charset=utf-8')
      : json(405, { message: 'Method not allowed' });
  }

  if (rawPath === '/api/forms') {
    return method === 'GET' ? listForms() : json(405, { message: 'Method not allowed' });
  }

  const exportMatch = FORM_SUBMISSIONS_EXPORT_PATH.exec(rawPath);
  if (exportMatch) {
    const formId = decodeFormId(exportMatch[1]);
    if (formId === undefined) {
      return json(404, { message: 'Form not found' });
    }
    return method === 'GET'
      ? exportSubmissions(formId, event.queryStringParameters)
      : json(405, { message: 'Method not allowed' });
  }

  const submissionsMatch = FORM_SUBMISSIONS_PATH.exec(rawPath);
  if (submissionsMatch) {
    const formId = decodeFormId(submissionsMatch[1]);
    if (formId === undefined) {
      return json(404, { message: 'Form not found' });
    }
    return method === 'GET'
      ? listSubmissions(formId, event.queryStringParameters)
      : json(405, { message: 'Method not allowed' });
  }

  const formMatch = FORM_ITEM_PATH.exec(rawPath);
  if (formMatch) {
    const formId = decodeFormId(formMatch[1]);
    if (formId === undefined) {
      return json(404, { message: 'Form not found' });
    }
    switch (method) {
      case 'GET':
        return getForm(formId);
      case 'PUT':
        return putForm(formId, getRequestBody(event));
      case 'DELETE':
        return deleteForm(formId);
      default:
        return json(405, { message: 'Method not allowed' });
    }
  }

  return json(404, { message: 'Not found' });
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    return await route(event);
  } catch (err) {
    console.error('Unhandled error in admin Lambda', err);
    return json(500, { message: 'Internal error' });
  }
};
