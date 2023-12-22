
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export const handler = async (_event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const headers: { [header: string]: string } = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Methods': 'OPTIONS,POST',
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Origin': '*', // allow all origins by default
    };

    // For demonstration purposes, allow all origins
    // Once there is a Forms admin and data tables for that, we can limit CORS to specific origins
    headers['Access-Control-Allow-Origin'] = '*';

    // If you want to limit CORS to specific origins, you could do something like this:
    // const allowedOrigins = ['https://www.example1.com', 'https://www.example2.com'];
    // const origin = event.headers['origin'] || event.headers['Origin'];
    // if (allowedOrigins.includes(origin)) {
    //   headers['Access-Control-Allow-Origin'] = origin;
    // }


    // ...rest of your handler logic

    return {
        statusCode: 204,
        headers: headers,
        body: '',
    };
};
