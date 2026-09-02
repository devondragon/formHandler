import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand, SendEmailCommandInput } from '@aws-sdk/client-ses';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

// create AWS SDK clients
export const dynamoClient = process.env.AWS_SAM_LOCAL
    ? new DynamoDBClient({ endpoint: "http://docker.for.mac.localhost:8000/" }) // MacOS
    // Windows: new DynamoDBClient({ endpoint: "http://docker.for.windows.localhost:8000/" })
    // Linux: new DynamoDBClient({ endpoint: "http://127.0.0.1:8000" })
    : new DynamoDBClient();

export const documentClient = DynamoDBDocumentClient.from(dynamoClient);
export const sesClient = new SESClient();


let isFormConfigActive: boolean | null = null;

const checkIfFormConfigActive = async (): Promise<boolean> => {
    const formTableName = process.env.FORM_TABLE_NAME;
    if (!formTableName) {
        console.log('Form table name is undefined. Make sure it is set in the environment variables.');
        return false;
    }
    try {
        // Check if table exists
        const tableDescription = await dynamoClient.send(new DescribeTableCommand({ TableName: formTableName }));
        if (!tableDescription.Table) {
            console.log(`Table ${formTableName} does not exist.`);
            return false;
        }

        // Check if table is populated
        const data = await documentClient.send(new ScanCommand({ TableName: formTableName }));
        if (data.Count && data.Count > 0) {
            console.log(`Table ${formTableName} is populated.`);
            return true;
        } else {
            console.log(`Table ${formTableName} is not populated.`);
            return false;
        }

    } catch (error) {
        console.log(`Error checking table ${formTableName}:`, error);
        return false;
    }
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

const sendEmail = async (item: any) => {

    const emailFrom = process.env.EMAIL_FROM;
    const emailTo = process.env.EMAIL_TO;
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
                Data: 'New Form Submission',
            },
        },
    };

    return sesClient.send(new SendEmailCommand(emailParams));
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    console.log("input:", JSON.stringify(event, undefined, 2));

    if (isFormConfigActive === null) {
        isFormConfigActive = await checkIfFormConfigActive();
    }

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

    // validate the input
    if (isFormConfigActive) {
        let formId = data.formId;
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
        await sendEmail(data);
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
