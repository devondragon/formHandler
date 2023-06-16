// Replace these values with those output by the cdk stack deploy command
import React from 'react';
import ReactDOM from 'react-dom';
import Amplify from 'aws-amplify';
import { withAuthenticator } from '@aws-amplify/ui-react';
import awsExports from './aws-exports.js';  // This file should contain your AWS configurations

Amplify.configure(awsExports);

const App = () => (
  <div>
    <h1>Welcome to the application</h1>
    <p>You are now signed in!</p>
  </div>
);

const AppWithAuthenticator = withAuthenticator(App);

ReactDOM.render(
  <React.StrictMode>
    <AppWithAuthenticator />
  </React.StrictMode>,
  document.getElementById('root')
);
