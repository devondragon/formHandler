import * as AWS from 'aws-sdk';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

const dynamodb = new AWS.DynamoDB.DocumentClient();

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const tableName = process.env.FORM_TABLE_NAME;
  if (!tableName) {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'FORM_TABLE_NAME environment variable not set' }),
    };
  }

  switch (event.httpMethod) {
    case 'GET':
      if (event.pathParameters?.id) {
        const result = await dynamodb
          .get({
            TableName: tableName,
            Key: { id: event.pathParameters.id },
          })
          .promise();
        if (result.Item) {
          return {
            statusCode: 200,
            body: JSON.stringify(result.Item),
          };
        } else {
          return {
            statusCode: 404,
            body: JSON.stringify({ message: 'Item not found' }),
          };
        }
      } else {
        const result = await dynamodb.scan({ TableName: tableName }).promise();
        return {
          statusCode: 200,
          body: JSON.stringify(result.Items),
        };
      }
    case 'POST':
      const item = JSON.parse(event.body || '{}');
      if (!item.id) {
        return {
          statusCode: 400,
          body: JSON.stringify({ message: 'id is required' }),
        };
      }
      await dynamodb
        .put({
          TableName: tableName,
          Item: item,
        })
        .promise();
      return {
        statusCode: 201,
        body: JSON.stringify(item),
      };
    case 'PUT':
      if (!event.pathParameters?.id) {
        return {
          statusCode: 400,
          body: JSON.stringify({ message: 'id is required' }),
        };
      }
      const updatedItem = JSON.parse(event.body || '{}');
      await dynamodb
        .update({
          TableName: tableName,
          Key: { id: event.pathParameters.id },
          UpdateExpression: 'set #name = :name, #email = :email',
          ExpressionAttributeNames: { '#name': 'name', '#email': 'email' },
          ExpressionAttributeValues: { ':name': updatedItem.name, ':email': updatedItem.email },
        })
        .promise();
      return {
        statusCode: 200,
        body: JSON.stringify(updatedItem),
      };
    case 'DELETE':
      if (!event.pathParameters?.id) {
        return {
          statusCode: 400,
          body: JSON.stringify({ message: 'id is required' }),
        };
      }
      await dynamodb
        .delete({
          TableName: tableName,
          Key: { id: event.pathParameters.id },
        })
        .promise();
      return {
        statusCode: 204,
        body: '',
      };
    default:
      return {
        statusCode: 405,
        body: JSON.stringify({ message: 'Method not allowed' }),
      };
  }
}
