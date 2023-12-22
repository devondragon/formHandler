# Devon Hillard's Form Handler Project

Welcome to Devon Hillard's Form Handler Project. This is an open-source project that facilitates the submission and storage of web form data using the power of AWS infrastructure. Built with TypeScript, this project leverages the AWS CDK to define and provision a stack of AWS resources.

The stack includes multiple DynamoDB tables and Node.js AWS Lambda functions which are exposed using Amazon API Gateway. These tools together form a streamlined system that allows website form submissions to be stored efficiently in DynamoDB while alerting designated recipients via email.

This project is perfect for use cases where you need to handle web form submissions without the need for a complex back-end system.

## Configuration

Before getting started, copy the `example.env` file to a `.env` file in the project's root directory, and replace the default configurations with your own.

**Note:** As of now, the project doesn't support form configurations and takes in any data sent to it, sending alerts to the email configured in the `.env` file.

## Security Note

Though this is a functional system, it comes with potential security vulnerabilities. This includes the possibility of receiving an influx of fake form submissions from bots or malicious attackers which could lead to increased AWS costs. Also, as it currently stands, the system has minimal protection against XSS and other injection attacks. It is recommended to integrate security measures that suit your requirements.

## Future Features

I plan to add a web admin which will allow you to configure forms with form ID validation, per form email notification settings, per IP address submission limits, etc...

There will also be a web reporting engine to allow you to view, search, and export form submission data.


## Setting up the Admin

Unfortunately this currently requires a few manual steps.

### Configure Web Admin for Cognito Auth

The first tiem you run the 'cdk deploy' step you will get the Cognito Admin User Pool Id and Web Client Id output from the cdk command.

Copy the admin-html/js/aws-exports.js-example file to aws-exports.js, and replace the placeholders with the values from your CDK app output.  Save the file.

Then, re-run 'cdk deploy' and it will copy the new file up to your Admin Web App's S3 bucket.

### Create Admin User in Cognito

You will need to create one, or more, admin users, who will be able to access the web admin and administer your forms.

You can do this from the Cognito Pool Admin, or you can create them from the command line.  Replace the placeholder values, denoted with '$$' in each of these two commands, and run them.  The first command creates the user, and the second command tells Cognito that the password is permanent and doesn't need to be changed on first login.

```bash
aws cognito-idp admin-create-user --user-pool-id us-west-2_$$POOLID$$ --username $$adminusername$$ --temporary-password $$SUPERSECUREPASSWORD$$ --message-action SUPPRESS

aws cognito-idp admin-set-user-password --user-pool-id us-west-2_$$POOLID$$ --username $$adminusername$$ --password $$SUPERSECUREPASSWORD$$ --permanent
```





## Testing the Application

Included in the repository are a test HTML file (`index.html`) and a JavaScript file (`formHandler.js`) which serve as a simple front-end to interact with the deployed serverless backend.

The HTML file contains a simple form. When the form is submitted, it triggers a function defined in `formHandler.js` which gathers the form data and sends it to the API endpoint as a POST request.

### Running the Test Front-end Locally

To test the application locally:

1. Open `client-side/js/formHandler.js` and replace `API_ENDPOINT` at the top of the file with the URL output from your CDK deployment. This is the endpoint for the API Gateway that was deployed by the CDK.

2. Since browsers enforce strict security measures around opening local files, you'll need to serve the HTML file using a local HTTP server. Python's built-in HTTP server is one easy way to do this.

    * If you have Python installed, navigate to the client-side directory containing `index.html` and `js/formHandler.js`, and run the command:

    ```bash
    python -m http.server 8000
    ```

    * This will start a simple HTTP server serving files on port 8000. If you want to use a different port, replace `8000` with your desired port number.

3. Open a web browser and navigate to `http://localhost:8000`. You should see the form displayed.

4. Fill in the form fields and submit the form. The page will display a success message when the form data has been successfully submitted and processed by the API.

### Important Notes

Please note that this is a very simple front-end intended for testing purposes only. It doesn't include any error handling for failed requests or invalid form data, so it may not behave correctly if the API endpoint isn't configured correctly or if the form data doesn't match what the backend expects.

Moreover, remember that for CORS to work correctly, your request must be served from an HTTP or HTTPS protocol. It won't work with the `file://` protocol. This is why you need to run a local HTTP server for testing.


## Project Structure

The `cdk.json` file is a key file that instructs the CDK Toolkit on how to execute your app.

## Useful Commands

Here are some commands that will help you with your development process:

* `npm run build`: This command is used to compile the TypeScript code to JavaScript.
* `npm run watch`: This command watches for any changes in your TypeScript files and compiles them automatically.
* `npm run test`: This command runs the jest unit tests.
* `cdk deploy`: This command deploys this stack to your default AWS account/region.
* `cdk diff`: This command compares the deployed stack with the current state.
* `cdk synth`: This command emits the synthesized CloudFormation template.

## Contributions

We appreciate contributions from the community. If you wish to contribute, please submit a pull request.
