var poolData = {
    UserPoolId: awsExports.aws_user_pools_id,
    ClientId: awsExports.aws_user_pools_web_client_id
};

var userPool = new AmazonCognitoIdentity.CognitoUserPool(poolData);

document.getElementById('loginForm').addEventListener('submit', function (evt) {
    evt.preventDefault();
    var username = document.getElementById('username').value;
    var password = document.getElementById('password').value;


    var authenticationData = {
        Username: username,
        Password: password,
    };
    var authenticationDetails = new AmazonCognitoIdentity.AuthenticationDetails(authenticationData);

    var userData = {
        Username: username,
        Pool: userPool,
    };
    var cognitoUser = new AmazonCognitoIdentity.CognitoUser(userData);
    cognitoUser.authenticateUser(authenticationDetails, {
        onSuccess: function (result) {
            document.getElementById('message').innerText = 'Logged in!';
            // Use the idToken for Logins Map when Federating User Pools with identity pools or when passing through an Authorization Header to an API Gateway Authorizer
            var idToken = result.idToken.jwtToken;
        },

        onFailure: function (err) {
            document.getElementById('message').innerText = 'Error: ' + err.message;
        },
        newPasswordRequired: function (userAttributes, requiredAttributes) {
            // User was signed up by an admin and must provide new
            // password and required attributes, if any, to complete
            // authentication.
            console.log('User needs to set a new password');
            // the api doesn't accept this field back
            delete userAttributes.email_verified;
            // Get these details and call
            cognitoUser.completeNewPasswordChallenge(newPassword, userAttributes, this);
        },
    });
});
