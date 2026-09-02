import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import {
  decodeCursor,
  encodeCursor,
  matchesSearch,
  SubmissionRepository,
  toCsv,
} from '../functions/shared/submissions';

describe('matchesSearch', () => {
  test('matches case-insensitively across string attributes', () => {
    const item = { id: '1', name: 'Jane Doe', email: 'jane@example.com' };
    expect(matchesSearch(item, 'JANE')).toBe(true);
    expect(matchesSearch(item, 'example.com')).toBe(true);
    expect(matchesSearch(item, 'doe')).toBe(true);
  });

  test('ignores non-string attributes', () => {
    const item = { id: '1', age: 42, active: true, count: 42 };
    expect(matchesSearch(item, '42')).toBe(false);
    expect(matchesSearch(item, 'true')).toBe(false);
  });

  test('returns false when nothing matches', () => {
    const item = { id: '1', name: 'Jane Doe' };
    expect(matchesSearch(item, 'zzz')).toBe(false);
  });
});

describe('encodeCursor / decodeCursor', () => {
  test('round-trips a key object', () => {
    const key = { id: 'abc', timestamp: '2026-01-01T00:00:00.000Z', formId: 'contact-us' };
    const cursor = encodeCursor(key);
    expect(decodeCursor(cursor)).toEqual(key);
  });

  test('decodeCursor throws on garbage input', () => {
    expect(() => decodeCursor('not-valid-base64url-json!!!')).toThrow();
  });

  test('decodeCursor throws on valid base64url that is not JSON', () => {
    const notJson = Buffer.from('not json').toString('base64url');
    expect(() => decodeCursor(notJson)).toThrow();
  });

  test('decodeCursor throws on an empty object', () => {
    const cursor = Buffer.from(JSON.stringify({}), 'utf8').toString('base64url');
    expect(() => decodeCursor(cursor)).toThrow();
  });

  test('decodeCursor throws when formId is missing', () => {
    const cursor = Buffer.from(
      JSON.stringify({ id: 'abc', timestamp: '2026-01-01T00:00:00.000Z' }),
      'utf8'
    ).toString('base64url');
    expect(() => decodeCursor(cursor)).toThrow();
  });

  test('decodeCursor throws when timestamp is not a string', () => {
    const cursor = Buffer.from(
      JSON.stringify({ id: 'abc', timestamp: 12345, formId: 'contact-us' }),
      'utf8'
    ).toString('base64url');
    expect(() => decodeCursor(cursor)).toThrow();
  });
});

describe('toCsv', () => {
  test('empty input produces just the header line for the five fixed columns', () => {
    expect(toCsv([])).toBe('id,timestamp,sourceIP,forwardedFor,formId\r\n');
  });

  test('column order: fixed columns first, then other attributes sorted alphabetically', () => {
    const rows = [
      {
        id: '1',
        timestamp: '2026-01-01T00:00:00.000Z',
        sourceIP: '1.2.3.4',
        forwardedFor: '',
        formId: 'contact-us',
        zebra: 'z',
        apple: 'a',
      },
    ];
    const csv = toCsv(rows);
    const [header] = csv.split('\r\n');
    expect(header).toBe('id,timestamp,sourceIP,forwardedFor,formId,apple,zebra');
  });

  test('quotes values containing commas, quotes, or newlines and doubles embedded quotes', () => {
    const rows = [
      {
        id: '1',
        timestamp: 't',
        sourceIP: 's',
        forwardedFor: 'f',
        formId: 'contact-us',
        note: 'has, a comma',
        quote: 'has "quotes"',
        newline: 'line1\nline2',
        cr: 'line1\rline2',
      },
    ];
    const csv = toCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id,timestamp,sourceIP,forwardedFor,formId,cr,newline,note,quote');
    expect(lines[1]).toBe(
      '1,t,s,f,contact-us,"line1\rline2","line1\nline2","has, a comma","has ""quotes"""'
    );
  });

  test('non-string values are JSON-stringified', () => {
    const rows = [
      {
        id: '1',
        timestamp: 't',
        sourceIP: 's',
        forwardedFor: 'f',
        formId: 'contact-us',
        count: 42,
        active: true,
        tags: ['a', 'b'],
      },
    ];
    const csv = toCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id,timestamp,sourceIP,forwardedFor,formId,active,count,tags');
    expect(lines[1]).toBe('1,t,s,f,contact-us,true,42,"[""a"",""b""]"');
  });

  test('missing attributes are empty cells', () => {
    const rows = [
      { id: '1', timestamp: 't', sourceIP: 's', forwardedFor: 'f', formId: 'a', extra: 'x' },
      { id: '2', timestamp: 't2', sourceIP: 's2', forwardedFor: 'f2', formId: 'a' },
    ];
    const csv = toCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id,timestamp,sourceIP,forwardedFor,formId,extra');
    expect(lines[1]).toBe('1,t,s,f,a,x');
    expect(lines[2]).toBe('2,t2,s2,f2,a,');
  });

  test('rows end with CRLF', () => {
    const rows = [{ id: '1', timestamp: 't', sourceIP: 's', forwardedFor: 'f', formId: 'a' }];
    const csv = toCsv(rows);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(3); // header, row, trailing empty
  });

  test('quotes a header cell whose attribute name contains a comma', () => {
    const rows = [
      {
        id: '1',
        timestamp: 't',
        sourceIP: 's',
        forwardedFor: 'f',
        formId: 'a',
        'first, last': 'Jane Doe',
      },
    ];
    const csv = toCsv(rows);
    const [header] = csv.split('\r\n');
    expect(header).toBe('id,timestamp,sourceIP,forwardedFor,formId,"first, last"');
  });
});

describe('SubmissionRepository', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient());
  const repository = new SubmissionRepository(client, 'formSubmissions');

  beforeEach(() => {
    ddbMock.reset();
  });

  function item(id: string, timestamp: string, extra: Record<string, unknown> = {}) {
    return { id, timestamp, formId: 'contact-us', sourceIP: '1.2.3.4', ...extra };
  }

  describe('query key condition expression', () => {
    test('no bounds: formId only', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await repository.query({ formId: 'contact-us', limit: 50 });

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      expect(input.IndexName).toBe('formId-timestamp-index');
      expect(input.KeyConditionExpression).toBe('formId = :formId');
      expect(input.ExpressionAttributeValues).toEqual({ ':formId': 'contact-us' });
      expect(input.ScanIndexForward).toBe(false);
    });

    test('from only uses >=', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await repository.query({
        formId: 'contact-us',
        from: '2026-01-01T00:00:00.000Z',
        limit: 50,
      });

      const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
      expect(input.KeyConditionExpression).toBe('formId = :formId AND #ts >= :from');
      expect(input.ExpressionAttributeValues).toEqual({
        ':formId': 'contact-us',
        ':from': '2026-01-01T00:00:00.000Z',
      });
    });

    test('to only uses <=', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await repository.query({
        formId: 'contact-us',
        to: '2026-01-31T23:59:59.999Z',
        limit: 50,
      });

      const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
      expect(input.KeyConditionExpression).toBe('formId = :formId AND #ts <= :to');
      expect(input.ExpressionAttributeValues).toEqual({
        ':formId': 'contact-us',
        ':to': '2026-01-31T23:59:59.999Z',
      });
    });

    test('both bounds uses BETWEEN', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      await repository.query({
        formId: 'contact-us',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T23:59:59.999Z',
        limit: 50,
      });

      const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
      expect(input.KeyConditionExpression).toBe('formId = :formId AND #ts BETWEEN :from AND :to');
      expect(input.ExpressionAttributeValues).toEqual({
        ':formId': 'contact-us',
        ':from': '2026-01-01T00:00:00.000Z',
        ':to': '2026-01-31T23:59:59.999Z',
      });
    });

    test('always queries newest first', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      await repository.query({ formId: 'contact-us', limit: 50 });
      expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.ScanIndexForward).toBe(false);
    });
  });

  describe('query search and pagination', () => {
    test('search matches case-insensitively and filters out non-matching items', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          item('1', '2026-01-03T00:00:00.000Z', { name: 'Jane Doe' }),
          item('2', '2026-01-02T00:00:00.000Z', { name: 'Bob' }),
        ],
      });

      const result = await repository.query({ formId: 'contact-us', q: 'jane', limit: 50 });

      expect(result.submissions).toHaveLength(1);
      expect(result.submissions[0]).toMatchObject({ id: '1' });
      expect(result.nextCursor).toBeUndefined();
    });

    test('continues across pages until limit is reached and returns a resumable cursor', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({
          Items: [item('1', '2026-01-05T00:00:00.000Z'), item('2', '2026-01-04T00:00:00.000Z')],
          LastEvaluatedKey: { id: '2', timestamp: '2026-01-04T00:00:00.000Z', formId: 'contact-us' },
        })
        .resolvesOnce({
          Items: [item('3', '2026-01-03T00:00:00.000Z'), item('4', '2026-01-02T00:00:00.000Z')],
          LastEvaluatedKey: { id: '4', timestamp: '2026-01-02T00:00:00.000Z', formId: 'contact-us' },
        });

      const result = await repository.query({ formId: 'contact-us', limit: 3 });

      expect(result.submissions.map((s: any) => s.id)).toEqual(['1', '2', '3']);
      expect(result.nextCursor).toBeDefined();
      expect(decodeCursor(result.nextCursor as string)).toEqual({
        id: '3',
        timestamp: '2026-01-03T00:00:00.000Z',
        formId: 'contact-us',
      });

      const calls = ddbMock.commandCalls(QueryCommand);
      expect(calls).toHaveLength(2);
      expect(calls[1].args[0].input.ExclusiveStartKey).toEqual({
        id: '2',
        timestamp: '2026-01-04T00:00:00.000Z',
        formId: 'contact-us',
      });
    });

    test('no cursor when the index is exhausted exactly at the limit', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [item('1', '2026-01-02T00:00:00.000Z'), item('2', '2026-01-01T00:00:00.000Z')],
      });

      const result = await repository.query({ formId: 'contact-us', limit: 2 });

      expect(result.submissions).toHaveLength(2);
      expect(result.nextCursor).toBeUndefined();
    });

    test('no cursor when fewer items than limit exist and index is exhausted', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [item('1', '2026-01-01T00:00:00.000Z')],
      });

      const result = await repository.query({ formId: 'contact-us', limit: 50 });

      expect(result.submissions).toHaveLength(1);
      expect(result.nextCursor).toBeUndefined();
    });

    test('resumes from an explicit cursor', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const cursor = encodeCursor({ id: '2', timestamp: '2026-01-04T00:00:00.000Z', formId: 'contact-us' });
      await repository.query({ formId: 'contact-us', limit: 50, cursor });

      const input = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
      expect(input.ExclusiveStartKey).toEqual({
        id: '2',
        timestamp: '2026-01-04T00:00:00.000Z',
        formId: 'contact-us',
      });
    });
  });

  describe('queryAll', () => {
    test('collects all matching items across pages until exhausted, not truncated', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({
          Items: [item('1', '2026-01-03T00:00:00.000Z')],
          LastEvaluatedKey: { id: '1', timestamp: '2026-01-03T00:00:00.000Z', formId: 'contact-us' },
        })
        .resolvesOnce({
          Items: [item('2', '2026-01-02T00:00:00.000Z')],
        });

      const result = await repository.queryAll({ formId: 'contact-us', maxRows: 10 });

      expect(result.submissions.map((s: any) => s.id)).toEqual(['1', '2']);
      expect(result.truncated).toBe(false);
    });

    test('sets truncated true when the cap is hit mid-page', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          item('1', '2026-01-03T00:00:00.000Z'),
          item('2', '2026-01-02T00:00:00.000Z'),
          item('3', '2026-01-01T00:00:00.000Z'),
        ],
      });

      const result = await repository.queryAll({ formId: 'contact-us', maxRows: 2 });

      expect(result.submissions.map((s: any) => s.id)).toEqual(['1', '2']);
      expect(result.truncated).toBe(true);
    });

    test('truncated is false when the cap is hit exactly on the last item of the final page', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [item('1', '2026-01-02T00:00:00.000Z'), item('2', '2026-01-01T00:00:00.000Z')],
      });

      const result = await repository.queryAll({ formId: 'contact-us', maxRows: 2 });

      expect(result.submissions.map((s: any) => s.id)).toEqual(['1', '2']);
      expect(result.truncated).toBe(false);
    });

    test('sets truncated true when the cap is hit exactly at a page boundary but more pages remain', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [item('1', '2026-01-03T00:00:00.000Z'), item('2', '2026-01-02T00:00:00.000Z')],
        LastEvaluatedKey: { id: '2', timestamp: '2026-01-02T00:00:00.000Z', formId: 'contact-us' },
      });

      const result = await repository.queryAll({ formId: 'contact-us', maxRows: 2 });

      expect(result.submissions).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });

    test('applies search filtering', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          item('1', '2026-01-02T00:00:00.000Z', { name: 'Jane' }),
          item('2', '2026-01-01T00:00:00.000Z', { name: 'Bob' }),
        ],
      });

      const result = await repository.queryAll({ formId: 'contact-us', q: 'jane', maxRows: 10 });

      expect(result.submissions.map((s: any) => s.id)).toEqual(['1']);
      expect(result.truncated).toBe(false);
    });
  });
});
