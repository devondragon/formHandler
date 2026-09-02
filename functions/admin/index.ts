import * as fs from 'fs';
import * as path from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { FormConfigRepository, validateFormConfig } from '../shared/form-config';

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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function serveStatic(name: string, contentType: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    },
    body: readUiFile(name),
  };
}

/** Serves `ui/index.html` with the Cognito config placeholders replaced from env. */
function serveIndexHtml(): APIGatewayProxyResultV2 {
  const region = process.env.AWS_REGION || process.env.COGNITO_REGION || '';
  const userPoolId = process.env.USER_POOL_ID || '';
  const userPoolClientId = process.env.USER_POOL_CLIENT_ID || '';

  const html = readUiFile('index.html')
    .split('__COGNITO_REGION__').join(JSON.stringify(region))
    .split('__USER_POOL_ID__').join(JSON.stringify(userPoolId))
    .split('__USER_POOL_CLIENT_ID__').join(JSON.stringify(userPoolClientId));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
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

/** API Gateway base64-encodes the body (e.g. for some client/proxy combinations); decode it before parsing. */
function getRequestBody(event: APIGatewayProxyEventV2): string | undefined {
  if (event.body === undefined) {
    return undefined;
  }
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

const FORM_ITEM_PATH = /^\/api\/forms\/([^/]+)$/;

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
      ? serveStatic('admin.js', 'application/javascript')
      : json(405, { message: 'Method not allowed' });
  }

  if (rawPath === '/admin.css') {
    return method === 'GET'
      ? serveStatic('admin.css', 'text/css')
      : json(405, { message: 'Method not allowed' });
  }

  if (rawPath === '/api/forms') {
    return method === 'GET' ? listForms() : json(405, { message: 'Method not allowed' });
  }

  const formMatch = FORM_ITEM_PATH.exec(rawPath);
  if (formMatch) {
    let formId: string;
    try {
      formId = decodeURIComponent(formMatch[1]);
    } catch (err) {
      console.warn('Invalid percent-encoding in form ID path segment', err);
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
