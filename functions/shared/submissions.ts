import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

/** A form submission item as stored in the submissions table. */
export type Submission = Record<string, unknown>;

/** The GSI key (`formId-timestamp-index`) used to resume a paginated query. */
export interface SubmissionCursorKey {
  id: unknown;
  timestamp: unknown;
  formId: unknown;
}

export interface SubmissionQueryParams {
  formId: string;
  from?: string;
  to?: string;
  q?: string;
  limit: number;
  cursor?: string;
}

export interface SubmissionQueryResult {
  submissions: Submission[];
  nextCursor?: string;
}

export interface SubmissionQueryAllParams {
  formId: string;
  from?: string;
  to?: string;
  q?: string;
  maxRows: number;
}

export interface SubmissionQueryAllResult {
  submissions: Submission[];
  truncated: boolean;
}

const FIXED_CSV_COLUMNS = ['id', 'timestamp', 'sourceIP', 'forwardedFor', 'formId'];

/**
 * Case-insensitive substring match against every string-valued attribute of
 * an item. DynamoDB cannot filter on unknown attribute names, so this is
 * applied to the Lambda's in-memory result set.
 */
export function matchesSearch(item: Submission, q: string): boolean {
  const needle = q.toLowerCase();
  return Object.values(item).some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(needle)
  );
}

/** Base64url-encodes a GSI key for use as an opaque pagination cursor. */
export function encodeCursor(key: SubmissionCursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/**
 * Decodes a pagination cursor produced by `encodeCursor`. Throws on
 * malformed input: invalid base64url/JSON, a non-object payload, or a
 * payload missing a string `id`, `timestamp`, or `formId`.
 */
export function decodeCursor(cursor: string): SubmissionCursorKey {
  const json = Buffer.from(cursor, 'base64url').toString('utf8');
  const parsed = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid cursor');
  }
  const { id, timestamp, formId } = parsed as Record<string, unknown>;
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof formId !== 'string') {
    throw new Error('Invalid cursor');
  }
  return { id, timestamp, formId };
}

/**
 * Leading characters that make a spreadsheet evaluate a cell as a formula
 * instead of showing it as text. Tab and carriage return are included because
 * Excel skips leading whitespace before deciding, so `\t=cmd()` is a formula.
 */
const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

function csvCell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // The apostrophe goes on before RFC 4180 quoting, so that it lands inside the
  // quotes and the spreadsheet sees it as the cell's first character.
  const raw = CSV_FORMULA_PREFIXES.includes(text.charAt(0)) ? `'${text}` : text;
  if (/["\r\n,]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Serializes rows to RFC 4180 CSV. Columns are the five fixed submission
 * fields, then every other attribute name found across the rows sorted by
 * field name. Missing attributes become empty cells; non-string values are
 * JSON-stringified; cells that would read as a spreadsheet formula are
 * prefixed with `'`; rows end with CRLF.
 */
export function toCsv(rows: Submission[]): string {
  const otherColumns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!FIXED_CSV_COLUMNS.includes(key)) {
        otherColumns.add(key);
      }
    }
  }
  const columns = [...FIXED_CSV_COLUMNS, ...[...otherColumns].sort()];

  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) {
    const cells = columns.map((column) => {
      if (!(column in row) || row[column] === undefined) {
        return '';
      }
      return csvCell(row[column]);
    });
    lines.push(cells.join(','));
  }

  return lines.join('\r\n') + '\r\n';
}

function itemKey(item: Submission): SubmissionCursorKey {
  return { id: item.id, timestamp: item.timestamp, formId: item.formId };
}

interface KeyCondition {
  KeyConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues: Record<string, unknown>;
}

function buildKeyCondition(formId: string, from?: string, to?: string): KeyCondition {
  const ExpressionAttributeValues: Record<string, unknown> = { ':formId': formId };

  if (from && to) {
    return {
      KeyConditionExpression: 'formId = :formId AND #ts BETWEEN :from AND :to',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: { ...ExpressionAttributeValues, ':from': from, ':to': to },
    };
  }
  if (from) {
    return {
      KeyConditionExpression: 'formId = :formId AND #ts >= :from',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: { ...ExpressionAttributeValues, ':from': from },
    };
  }
  if (to) {
    return {
      KeyConditionExpression: 'formId = :formId AND #ts <= :to',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: { ...ExpressionAttributeValues, ':to': to },
    };
  }
  return {
    KeyConditionExpression: 'formId = :formId',
    ExpressionAttributeValues,
  };
}

/** DynamoDB-backed access to submissions via the `formId-timestamp-index` GSI. */
export class SubmissionRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  async query(params: SubmissionQueryParams): Promise<SubmissionQueryResult> {
    const { formId, from, to, q, limit } = params;
    const keyCondition = buildKeyCondition(formId, from, to);

    const collected: Submission[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined = params.cursor
      ? (decodeCursor(params.cursor) as unknown as Record<string, unknown>)
      : undefined;
    let nextCursor: string | undefined;

    while (true) {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'formId-timestamp-index',
          KeyConditionExpression: keyCondition.KeyConditionExpression,
          ExpressionAttributeNames: keyCondition.ExpressionAttributeNames,
          ExpressionAttributeValues: keyCondition.ExpressionAttributeValues,
          ScanIndexForward: false,
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      const items = (result.Items ?? []) as Submission[];
      let truncatedMidPage = false;
      let lastMatchedKey: SubmissionCursorKey | undefined;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (q && !matchesSearch(item, q)) {
          continue;
        }
        collected.push(item);
        if (collected.length >= limit) {
          lastMatchedKey = itemKey(item);
          truncatedMidPage = i < items.length - 1;
          break;
        }
      }

      if (collected.length >= limit) {
        nextCursor = truncatedMidPage
          ? encodeCursor(lastMatchedKey as SubmissionCursorKey)
          : result.LastEvaluatedKey
            ? encodeCursor(result.LastEvaluatedKey as unknown as SubmissionCursorKey)
            : undefined;
        break;
      }

      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!exclusiveStartKey) {
        break;
      }
    }

    return nextCursor ? { submissions: collected, nextCursor } : { submissions: collected };
  }

  async queryAll(params: SubmissionQueryAllParams): Promise<SubmissionQueryAllResult> {
    const { formId, from, to, q, maxRows } = params;
    const keyCondition = buildKeyCondition(formId, from, to);

    const collected: Submission[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let truncated = false;

    while (true) {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'formId-timestamp-index',
          KeyConditionExpression: keyCondition.KeyConditionExpression,
          ExpressionAttributeNames: keyCondition.ExpressionAttributeNames,
          ExpressionAttributeValues: keyCondition.ExpressionAttributeValues,
          ScanIndexForward: false,
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      const items = (result.Items ?? []) as Submission[];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (q && !matchesSearch(item, q)) {
          continue;
        }
        collected.push(item);
        if (collected.length >= maxRows) {
          truncated = i < items.length - 1 || !!result.LastEvaluatedKey;
          return { submissions: collected, truncated };
        }
      }

      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!exclusiveStartKey) {
        break;
      }
    }

    return { submissions: collected, truncated };
  }
}
