import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import {
  FORM_ID_PATTERN,
  FormConfig,
  FormConfigInput,
  FormConfigRepository,
  validateFormConfig,
} from '../functions/shared/form-config';

const validInput = {
  formId: 'contact-us',
  formName: 'Contact Us',
  notificationEmail: 'owner@example.com',
  emailNotificationsEnabled: true,
  oneSubmissionPerIp: false,
  enabled: true,
};

describe('FORM_ID_PATTERN', () => {
  test('accepts letters, numbers, underscores, and hyphens up to 64 chars', () => {
    expect(FORM_ID_PATTERN.test('Contact-Us_123')).toBe(true);
    expect(FORM_ID_PATTERN.test('a'.repeat(64))).toBe(true);
  });

  test('rejects empty string, spaces, and strings over 64 chars', () => {
    expect(FORM_ID_PATTERN.test('')).toBe(false);
    expect(FORM_ID_PATTERN.test('has space')).toBe(false);
    expect(FORM_ID_PATTERN.test('a'.repeat(65))).toBe(false);
  });
});

describe('validateFormConfig', () => {
  test('happy path returns the trimmed value', () => {
    const result = validateFormConfig({
      formId: '  contact-us  ',
      formName: '  Contact Us  ',
      notificationEmail: '  owner@example.com  ',
      emailNotificationsEnabled: true,
      oneSubmissionPerIp: false,
      enabled: true,
    });

    expect(result).toEqual({
      value: {
        formId: 'contact-us',
        formName: 'Contact Us',
        notificationEmail: 'owner@example.com',
        emailNotificationsEnabled: true,
        oneSubmissionPerIp: false,
        enabled: true,
      },
    });
  });

  test('drops unknown extra properties without an error', () => {
    const result = validateFormConfig({ ...validInput, extra: 'nope' }) as { value: FormConfigInput };

    expect(result.value).not.toHaveProperty('extra');
  });

  test('rejects a non-object body', () => {
    const result = validateFormConfig('not an object') as { errors: string[] };
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('formId is required', () => {
    const { formId, ...rest } = validInput;
    const result = validateFormConfig(rest) as { errors: string[] };
    expect(result.errors).toContain('formId is required');
  });

  test('formId must match the allowed pattern', () => {
    const result = validateFormConfig({ ...validInput, formId: 'has space' }) as { errors: string[] };
    expect(result.errors).toContain(
      'formId must be 1-64 characters of letters, numbers, underscores, or hyphens'
    );
  });

  test('formName is required', () => {
    const { formName, ...rest } = validInput;
    const result = validateFormConfig(rest) as { errors: string[] };
    expect(result.errors).toContain('formName is required');
  });

  test('formName must be 1-200 characters after trim', () => {
    const result = validateFormConfig({ ...validInput, formName: '   ' }) as { errors: string[] };
    expect(result.errors).toContain('formName must be 1-200 characters');

    const tooLong = validateFormConfig({ ...validInput, formName: 'a'.repeat(201) }) as { errors: string[] };
    expect(tooLong.errors).toContain('formName must be 1-200 characters');
  });

  test('notificationEmail must contain a non-empty local and domain part', () => {
    const noAt = validateFormConfig({ ...validInput, notificationEmail: 'not-an-email' }) as { errors: string[] };
    expect(noAt.errors).toContain('notificationEmail must be a valid email address');

    const noLocal = validateFormConfig({ ...validInput, notificationEmail: '@example.com' }) as { errors: string[] };
    expect(noLocal.errors).toContain('notificationEmail must be a valid email address');

    const noDomain = validateFormConfig({ ...validInput, notificationEmail: 'owner@' }) as { errors: string[] };
    expect(noDomain.errors).toContain('notificationEmail must be a valid email address');
  });

  test('notificationEmail is required when emailNotificationsEnabled is true', () => {
    const { notificationEmail, ...rest } = validInput;
    const result = validateFormConfig(rest) as { errors: string[] };
    expect(result.errors).toContain(
      'notificationEmail is required when emailNotificationsEnabled is true'
    );
  });

  test('notificationEmail is optional when emailNotificationsEnabled is false', () => {
    const { notificationEmail, ...rest } = validInput;
    const result = validateFormConfig({ ...rest, emailNotificationsEnabled: false }) as { value: FormConfigInput };
    expect(result).toHaveProperty('value');
    expect(result.value.notificationEmail).toBeUndefined();
  });

  test('emailNotificationsEnabled is required', () => {
    const { emailNotificationsEnabled, ...rest } = validInput;
    const result = validateFormConfig(rest) as { errors: string[] };
    expect(result.errors).toContain('emailNotificationsEnabled is required');
  });

  test('oneSubmissionPerIp is required', () => {
    const { oneSubmissionPerIp, ...rest } = validInput;
    const result = validateFormConfig(rest) as { errors: string[] };
    expect(result.errors).toContain('oneSubmissionPerIp is required');
  });

  test('enabled is required', () => {
    const { enabled, ...rest } = validInput;
    const result = validateFormConfig(rest) as { errors: string[] };
    expect(result.errors).toContain('enabled is required');
  });

  test('reports every rule failure at once', () => {
    const result = validateFormConfig({}) as { errors: string[] };
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'formId is required',
        'formName is required',
        'emailNotificationsEnabled is required',
        'oneSubmissionPerIp is required',
        'enabled is required',
      ])
    );
  });

  test('expectedFormId mismatch produces an error', () => {
    const result = validateFormConfig(validInput, 'a-different-id') as { errors: string[] };
    expect(result.errors).toContain('formId in body does not match URL');
  });

  test('expectedFormId fills a missing formId without error', () => {
    const { formId, ...rest } = validInput;
    const result = validateFormConfig(rest, 'contact-us') as { value: FormConfigInput };
    expect(result).toHaveProperty('value');
    expect(result.value.formId).toBe('contact-us');
  });

  test('expectedFormId matching the body formId is not an error', () => {
    const result = validateFormConfig(validInput, 'contact-us') as { value: FormConfigInput };
    expect(result).toHaveProperty('value');
    expect(result.value.formId).toBe('contact-us');
  });
});

describe('FormConfigRepository', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient());
  const repository = new FormConfigRepository(client, 'forms');

  beforeEach(() => {
    ddbMock.reset();
  });

  test('get returns undefined when the item is missing', async () => {
    ddbMock.on(GetCommand).resolves({});

    const result = await repository.get('missing-form');

    expect(result).toBeUndefined();
    const calls = ddbMock.commandCalls(GetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      TableName: 'forms',
      Key: { formId: 'missing-form' },
    });
  });

  test('get returns the stored item', async () => {
    const item: FormConfig = {
      formId: 'contact-us',
      formName: 'Contact Us',
      emailNotificationsEnabled: false,
      oneSubmissionPerIp: false,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    ddbMock.on(GetCommand).resolves({ Item: item });

    const result = await repository.get('contact-us');

    expect(result).toEqual(item);
  });

  test('list merges paginated scan results and sorts by formId', async () => {
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [{ formId: 'zebra' }, { formId: 'apple' }],
        LastEvaluatedKey: { formId: 'zebra' },
      })
      .resolvesOnce({
        Items: [{ formId: 'mango' }],
      });

    const result = await repository.list();

    expect(result.map((f: FormConfig) => f.formId)).toEqual(['apple', 'mango', 'zebra']);
    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.ExclusiveStartKey).toEqual({ formId: 'zebra' });
  });

  test('put sets createdAt and updatedAt on create', async () => {
    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});

    const input: FormConfigInput = {
      formId: 'contact-us',
      formName: 'Contact Us',
      emailNotificationsEnabled: false,
      oneSubmissionPerIp: false,
      enabled: true,
    };

    const result = await repository.put(input);

    expect(result.createdAt).toEqual(result.updatedAt);
    expect(result.createdAt).toEqual(expect.any(String));

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item).toEqual(result);
  });

  test('put preserves createdAt on update and refreshes updatedAt', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        formId: 'contact-us',
        formName: 'Contact Us (old)',
        emailNotificationsEnabled: false,
        oneSubmissionPerIp: false,
        enabled: true,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      },
    });
    ddbMock.on(PutCommand).resolves({});

    const input: FormConfigInput = {
      formId: 'contact-us',
      formName: 'Contact Us (new)',
      emailNotificationsEnabled: false,
      oneSubmissionPerIp: false,
      enabled: true,
    };

    const result = await repository.put(input);

    expect(result.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(result.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  test('delete sends a DeleteCommand for the formId', async () => {
    ddbMock.on(DeleteCommand).resolves({});

    await repository.delete('contact-us');

    const calls = ddbMock.commandCalls(DeleteCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      TableName: 'forms',
      Key: { formId: 'contact-us' },
    });
  });

  test('hasAny returns true when the count is greater than zero', async () => {
    ddbMock.on(ScanCommand).resolves({ Count: 3 });

    const result = await repository.hasAny();

    expect(result).toBe(true);
    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls[0].args[0].input).toEqual({
      TableName: 'forms',
      Limit: 1,
      Select: 'COUNT',
    });
  });

  test('hasAny returns false when the count is zero', async () => {
    ddbMock.on(ScanCommand).resolves({ Count: 0 });

    const result = await repository.hasAny();

    expect(result).toBe(false);
  });
});
