import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

/**
 * A form configuration record, stored one-per-item in the forms table keyed
 * by `formId`. See the Design section of the Task 1 brief for the field
 * rules enforced by `validateFormConfig`.
 */
export interface FormConfig {
  formId: string;
  formName: string;
  notificationEmail?: string;
  emailNotificationsEnabled: boolean;
  oneSubmissionPerIp: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The subset of `FormConfig` accepted as input; `createdAt`/`updatedAt` are server-set. */
export type FormConfigInput = Omit<FormConfig, 'createdAt' | 'updatedAt'>;

export const FORM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ValidateFormConfigResult =
  | { value: FormConfigInput }
  | { errors: string[] };

/**
 * Validates and normalizes an unknown request body into a `FormConfigInput`.
 * Strings are trimmed; unknown extra properties are dropped rather than
 * flagged. When `expectedFormId` is given (the admin API's `PUT
 * /api/forms/{formId}` route param), a `formId` present in the input must
 * equal it, and a missing `formId` is filled in from it.
 */
export function validateFormConfig(
  input: unknown,
  expectedFormId?: string
): ValidateFormConfigResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { errors: ['Request body must be an object'] };
  }

  const raw = input as Record<string, unknown>;

  // formId
  let formId: string | undefined;
  if (typeof raw.formId === 'string') {
    const trimmed = raw.formId.trim();
    if (trimmed !== '') {
      formId = trimmed;
    }
  } else if (raw.formId !== undefined && raw.formId !== null) {
    errors.push('formId must be a string');
  }

  if (formId !== undefined && expectedFormId !== undefined && formId !== expectedFormId) {
    errors.push('formId in body does not match URL');
  }

  if (formId === undefined) {
    formId = expectedFormId;
  }

  if (!formId) {
    errors.push('formId is required');
  } else if (!FORM_ID_PATTERN.test(formId)) {
    errors.push('formId must be 1-64 characters of letters, numbers, underscores, or hyphens');
  }

  // formName
  let formName: string | undefined;
  if (typeof raw.formName !== 'string') {
    errors.push('formName is required');
  } else {
    const trimmed = raw.formName.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      errors.push('formName must be 1-200 characters');
    } else {
      formName = trimmed;
    }
  }

  // emailNotificationsEnabled
  let emailNotificationsEnabled: boolean | undefined;
  if (typeof raw.emailNotificationsEnabled !== 'boolean') {
    errors.push('emailNotificationsEnabled is required');
  } else {
    emailNotificationsEnabled = raw.emailNotificationsEnabled;
  }

  // notificationEmail
  let notificationEmail: string | undefined;
  let notificationEmailInvalid = false;
  if (raw.notificationEmail !== undefined && raw.notificationEmail !== null) {
    if (typeof raw.notificationEmail !== 'string') {
      errors.push('notificationEmail must be a valid email address');
      notificationEmailInvalid = true;
    } else {
      const trimmed = raw.notificationEmail.trim();
      if (trimmed !== '') {
        const atIndex = trimmed.indexOf('@');
        const local = atIndex > 0 ? trimmed.slice(0, atIndex) : '';
        const domain = atIndex >= 0 ? trimmed.slice(atIndex + 1) : '';
        if (local.length === 0 || domain.length === 0) {
          errors.push('notificationEmail must be a valid email address');
          notificationEmailInvalid = true;
        } else {
          notificationEmail = trimmed;
        }
      }
    }
  }

  if (emailNotificationsEnabled === true && !notificationEmail && !notificationEmailInvalid) {
    errors.push('notificationEmail is required when emailNotificationsEnabled is true');
  }

  // oneSubmissionPerIp
  let oneSubmissionPerIp: boolean | undefined;
  if (typeof raw.oneSubmissionPerIp !== 'boolean') {
    errors.push('oneSubmissionPerIp is required');
  } else {
    oneSubmissionPerIp = raw.oneSubmissionPerIp;
  }

  // enabled
  let enabled: boolean | undefined;
  if (typeof raw.enabled !== 'boolean') {
    errors.push('enabled is required');
  } else {
    enabled = raw.enabled;
  }

  if (errors.length > 0) {
    return { errors };
  }

  const value: FormConfigInput = {
    formId: formId as string,
    formName: formName as string,
    emailNotificationsEnabled: emailNotificationsEnabled as boolean,
    oneSubmissionPerIp: oneSubmissionPerIp as boolean,
    enabled: enabled as boolean,
  };
  if (notificationEmail !== undefined) {
    value.notificationEmail = notificationEmail;
  }

  return { value };
}

/** DynamoDB-backed access to form configuration records, keyed by `formId`. */
export class FormConfigRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string
  ) {}

  async get(formId: string): Promise<FormConfig | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { formId },
      })
    );
    return result.Item as FormConfig | undefined;
  }

  async list(): Promise<FormConfig[]> {
    const items: FormConfig[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      const result = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          ExclusiveStartKey: exclusiveStartKey,
        })
      );
      if (result.Items) {
        items.push(...(result.Items as FormConfig[]));
      }
      exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);

    return items.sort((a, b) => a.formId.localeCompare(b.formId));
  }

  async put(input: FormConfigInput): Promise<FormConfig> {
    const existing = await this.get(input.formId);
    const now = new Date().toISOString();
    const item: FormConfig = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      })
    );

    return item;
  }

  async delete(formId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { formId },
      })
    );
  }

  async hasAny(): Promise<boolean> {
    const result = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: 1,
        Select: 'COUNT',
      })
    );
    return (result.Count ?? 0) > 0;
  }
}
