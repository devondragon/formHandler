import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand, SendEmailCommandInput } from '@aws-sdk/client-ses';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
import { FormConfig, FormConfigRepository } from '../shared/form-config';

// create AWS SDK clients
export const dynamoClient = process.env.AWS_SAM_LOCAL
    ? new DynamoDBClient({ endpoint: "http://docker.for.mac.localhost:8000/" }) // MacOS
    // Windows: new DynamoDBClient({ endpoint: "http://docker.for.windows.localhost:8000/" })
    // Linux: new DynamoDBClient({ endpoint: "http://127.0.0.1:8000" })
    : new DynamoDBClient();

export const documentClient = DynamoDBDocumentClient.from(dynamoClient, {
    marshallOptions: { removeUndefinedValues: true },
});
export const sesClient = new SESClient();

/** How long a "config mode is active" result is trusted before it is re-checked. */
const CONFIG_CHECK_TTL_MS = 60_000;

let configCache: { active: boolean; checkedAt: number } | null = null;

/** Test-only hook: clears the cached config-mode check. */
export const resetConfigCache = (): void => {
    configCache = null;
};

const checkIfFormConfigActive = async (): Promise<boolean> => {
    const now = Date.now();
    if (configCache && now - configCache.checkedAt < CONFIG_CHECK_TTL_MS) {
        return configCache.active;
    }

    const formTableName = process.env.FORM_TABLE_NAME;
    let active = false;

    if (!formTableName) {
        console.log('Form table name is undefined. Make sure it is set in the environment variables.');
    } else {
        try {
            const repository = new FormConfigRepository(documentClient, formTableName);
            active = await repository.hasAny();
        } catch (error) {
            console.log(`Error checking table ${formTableName}:`, error);
            active = false;
        }
    }

    configCache = { active, checkedAt: now };
    return active;
}

const writeFormSubmissionToDynamoDB = async (item: any) => {
    const formSubmissionTableName = process.env.FORM_SUBMISSIONS_TABLE_NAME;

    if (!formSubmissionTableName) {
        throw new Error('Table name is undefined. Make sure it is set in the environment variables.');
    }

    return documentClient.send(new PutCommand({
        TableName: formSubmissionTableName,
        Item: item,
    }));
}

const sendEmail = async (item: any, config?: FormConfig) => {
    if (config && !config.emailNotificationsEnabled) {
        console.log(`Email notifications disabled for form ${config.formId}`);
        return;
    }

    const emailFrom = process.env.EMAIL_FROM;
    const emailTo = config?.notificationEmail ?? process.env.EMAIL_TO;
    if (!emailFrom || !emailTo) {
        throw new Error('Email from or to is undefined. Make sure it is set in the environment variables.');
    }
    let htmlBody = "<h1>New Form Submission</h1>";
    Object.keys(item).forEach((key) => {
        // sanitize user-provided input
        let value = item[key];
        if (typeof value === 'string') {
            value = value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        }
        htmlBody += `<p><strong>${key}:</strong> ${value}</p>`;
    });

    const emailParams: SendEmailCommandInput = {
        // TODO: set these to use ENV variables and/or load from Form data
        Source: emailFrom,
        Destination: {
            ToAddresses: [
                emailTo,
            ],
        },
        Message: {
            Body: {
                Html: {
                    Data: htmlBody,
                },
            },
            Subject: {
                Data: config ? `New submission: ${config.formName}` : 'New Form Submission',
            },
        },
    };

    return sesClient.send(new SendEmailCommand(emailParams));
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    console.log("input:", JSON.stringify(event, undefined, 2));

    const isFormConfigActive = await checkIfFormConfigActive();

    // parse the JSON body of the event
    let data: any;

    try {
        // parse the JSON body of the event
        data = JSON.parse(event.body || '{}');
    } catch (err) {
        console.log('Error parsing JSON body:', err, 'Body:', event.body);
        return {
            statusCode: 400,
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ message: "Invalid JSON in request body" }),
        };
    }

    // validate the input and, in config mode, load the matching form configuration
    let config: FormConfig | undefined;
    if (isFormConfigActive) {
        const formId = data.formId;
        if (!formId) {
            console.log('Form ID is missing');
            return {
                statusCode: 400,
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ message: "Form ID is missing" }),
            };
        }

        try {
            const formTableName = process.env.FORM_TABLE_NAME as string;
            const repository = new FormConfigRepository(documentClient, formTableName);
            config = await repository.get(formId);

            if (!config) {
                console.log(`Unknown form: ${formId}`);
                return {
                    statusCode: 404,
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ message: "Unknown form" }),
                };
            }

            if (!config.enabled) {
                console.log(`Form is disabled: ${formId}`);
                return {
                    statusCode: 403,
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ message: "Form is disabled" }),
                };
            }

            if (config.oneSubmissionPerIp) {
                const formSubmissionTableName = process.env.FORM_SUBMISSIONS_TABLE_NAME as string;
                const sourceIp = event.requestContext.http.sourceIp;
                const existing = await documentClient.send(new QueryCommand({
                    TableName: formSubmissionTableName,
                    IndexName: 'formId-sourceIP-index',
                    KeyConditionExpression: 'formId = :formId AND sourceIP = :sourceIP',
                    ExpressionAttributeValues: {
                        ':formId': formId,
                        ':sourceIP': sourceIp,
                    },
                    Limit: 1,
                }));

                if (existing.Count && existing.Count > 0) {
                    console.log(`Duplicate submission blocked for form ${formId} from ${sourceIp}`);
                    return {
                        statusCode: 429,
                        headers: {
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({ message: "Only one submission per IP address is allowed for this form" }),
                    };
                }
            }
        } catch (err) {
            console.log('Error reading form configuration', err);
            return {
                statusCode: 500,
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ message: "Error reading form configuration" }),
            };
        }
    }

    // add unique id, source IP and timestamp
    data.id = randomUUID();
    data.forwardedFor = event.headers['X-Forwarded-For'] || event.headers['x-forwarded-for'];
    data.sourceIP = event.requestContext.http.sourceIp;
    data.timestamp = new Date().toISOString();

    try {
        await writeFormSubmissionToDynamoDB(data);
        console.log('Written to DynamoDB');
    } catch (err) {
        console.log('Error writing to DynamoDB', err);
        return {
            statusCode: 500,
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ message: "Error writing to DynamoDB" }),
        };
    }

    try {
        await sendEmail(data, config);
        console.log('Email sent');
    } catch (err) {
        console.log('Error sending email', err);
        return {
            statusCode: 500,
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ message: "Error sending email" }),
        };
    }

    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Credentials": true,
        },
        body: JSON.stringify(data),
    };
};
