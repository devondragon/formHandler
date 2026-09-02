# Devon Hillard's Form Handler Project

Welcome to Devon Hillard's Form Handler Project. This is an open-source project that facilitates the submission and storage of web form data using the power of AWS infrastructure. Built with TypeScript, this project leverages the AWS CDK to define and provision a stack of AWS resources.

The stack includes multiple DynamoDB tables and Node.js AWS Lambda functions which are exposed using Amazon API Gateway. These tools together form a streamlined system that allows website form submissions to be stored efficiently in DynamoDB while alerting designated recipients via email.

This project is perfect for use cases where you need to handle web form submissions without the need for a complex back-end system.

## Requirements

- Node.js 22 or newer (Node.js 24 recommended; `.nvmrc` is provided)
- npm
- An AWS account with an SES sender email address verified

Install dependencies with `npm ci`.

The Lambda functions run on the Node.js 24 runtime and use AWS SDK for JavaScript v3.

## Upgrading from earlier versions

The forms table key changed from the composite key (`formId`, `formName`) to a partition key of `formId` alone, because a form configuration has to be addressable by its ID. DynamoDB cannot change the key schema of an existing table, and the table name is fixed by `FORM_TABLE_NAME`, so before deploying this version you must either delete the existing `forms` table or point `FORM_TABLE_NAME` at a new name. The table held no data in any earlier release, so nothing is lost by deleting it.

Lambda logs now go to CDK-managed log groups with generated names instead of the fixed names used previously. The old `/aws/lambda/form-handler-lambda` and `/aws/lambda/form-handler-cors-lambda` groups keep their history and can be deleted manually once you no longer need them.

## Configuration

Before getting started, copy the `example.env` file to a `.env` file and replace the default configurations with your own. `ADMIN_EMAIL` is required: it is the email address of the first administrator, and the deployment creates a Cognito user for it.

With no form configurations stored, the handler accepts any data sent to it and sends alerts to the `EMAIL_TO` address, as it always has. Once you create your first form in the admin interface, per-form configuration takes over. See [Admin](#admin) below.

Setting `NODE_ENV=production` at synth time (`NODE_ENV=production cdk deploy`) switches the removal policy of the DynamoDB tables and the Cognito user pool to `RETAIN`, so a stack deletion leaves your form configurations, submissions, and administrator accounts in place. Without it, those resources are destroyed along with the stack.

## Security Note

Though this is a functional system, it comes with potential security vulnerabilities. This includes the possibility of receiving an influx of fake form submissions from bots or malicious attackers which could lead to increased AWS costs. Also, as it currently stands, the system has minimal protection against XSS and other injection attacks. It is recommended to integrate security measures that suit your requirements.

## Admin

The stack deploys a small web admin for creating and configuring forms. It is a single Lambda behind its own API Gateway HTTP API that serves both the admin page and its JSON API. There is no S3 bucket and no separate front-end build.

The deployment prints the admin address as the `AdminUrl` CloudFormation output.

### Signing in

Authentication is an Amazon Cognito user pool. Self sign-up is disabled, so the only accounts are ones an administrator creates.

1. Set `ADMIN_EMAIL` in your `.env` file before deploying. The deployment creates a Cognito user with that email address as the username.
2. Cognito emails that address a temporary password.
3. Open `AdminUrl`, sign in with the email address and the temporary password. Cognito requires a new password on first login, and the page prompts for one before it lets you in.

To add more administrators, create additional users in the Cognito user pool (its ID is the `AdminUserPoolId` output). The pool's app client ID is the `AdminUserPoolClientId` output.

The temporary password Cognito emails expires after 7 days. If it expires before first login, recover the account with the AWS CLI:

```bash
# Set a specific permanent password
aws cognito-idp admin-set-user-password --user-pool-id <AdminUserPoolId> --username <email> --password <new-password> --permanent

# Or have Cognito re-send a new temporary password
aws cognito-idp admin-create-user --user-pool-id <AdminUserPoolId> --username <email> --message-action RESEND
```

A session lasts 60 minutes. The page holds the Cognito ID token for that hour and does not refresh it, so after 60 minutes the admin API starts rejecting requests and the page asks you to sign in again.

Changing `ADMIN_EMAIL` and redeploying replaces the seeded administrator: the CDK-managed Cognito user for the previous address is deleted, and a new one is created for the new address. It does not affect any other administrators you created by hand.

### Form configuration

Each form is a record in the forms table with these fields:

* `formId`: the identifier the client sends with the submission. Required, and limited to letters, digits, underscores, and hyphens (1 to 64 characters).
* `formName`: a human-readable name, 1 to 200 characters. Used in the notification email subject.
* `notificationEmail`: the address that notification emails go to. Required when `emailNotificationsEnabled` is on; when it is missing, notifications fall back to `EMAIL_TO`.
* `emailNotificationsEnabled`: whether a submission to this form sends a notification email.
* `oneSubmissionPerIp`: whether a source IP address is limited to a single submission for this form. Two caveats. The check is a query followed by a write, not an atomic condition, so two near-simultaneous submissions from one address can both get through. And the address is the one API Gateway sees, so if a proxy or CDN sits in front of the API, every visitor shares a single IP address and only the first submission is accepted.
* `enabled`: whether the form accepts submissions at all.

`createdAt` and `updatedAt` are set by the server.

### How submissions are handled

The form handler works in one of two modes, decided by whether the forms table holds any configuration at all. The check is cached for 60 seconds, so a newly created first form takes up to a minute to take effect.

* **No form configurations exist (legacy mode).** Behavior is unchanged from earlier versions: any submission is accepted and stored, whether or not it includes a `formId`, and an email goes to `EMAIL_TO`.
* **At least one form configuration exists.** Submissions are matched to their configuration:
  * a submission with no `formId` gets `400 Form ID is missing`;
  * a `formId` with no matching configuration gets `404 Unknown form`;
  * a form with `enabled` off gets `403 Form is disabled`;
  * a form with `oneSubmissionPerIp` on that already has a submission from the same source IP address gets `429 Only one submission per IP address is allowed for this form`;
  * otherwise the submission is stored, and a notification email is sent only if `emailNotificationsEnabled` is on.

### Submission reports

The **Submissions** action on a row of the forms table opens that form's submissions, newest first.

* **Date range.** The From and To dates filter on the submission timestamp. Either bound can be left empty, and the To date includes the whole day you pick.
* **Search.** The search box matches a case-insensitive substring against every text value in a submission, including the submitted fields, so you do not have to know which field holds the text.
* **Load more.** A page of 50 submissions loads at a time. **Load more** appears while there are more to fetch and appends the next page to the table.
* **Columns.** The table shows `timestamp` and `sourceIP`, then the submitted fields found in the loaded rows in alphabetical order, then `id`, `forwardedFor`, and `formId`. Different submissions to one form can carry different fields, so the columns are recalculated as more rows load.
* **Export.** **Export CSV** and **Export JSON** download every submission matching the current date range and search, not only the rows on screen. An export is capped at 10,000 rows; past that the file holds the 10,000 newest matches and the rest are omitted. Narrow the date range to get the remainder.

Reports are per form and read the submissions table by `formId`. Submissions received before any form configuration existed (legacy mode, described above) have no `formId`, so they do not appear in any form's report or export.

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
