(function () {
  'use strict';

  var ID_TOKEN_KEY = 'formHandlerAdminIdToken';
  var config = window.ADMIN_CONFIG || {};
  var cognitoEndpoint = 'https://cognito-idp.' + config.region + '.amazonaws.com/';

  // Set while a NEW_PASSWORD_REQUIRED challenge is in progress.
  var pendingChallenge = null;

  var els = {};

  function cacheElements() {
    els.signOutBtn = document.getElementById('sign-out-btn');
    els.loginSection = document.getElementById('login-section');
    els.loginForm = document.getElementById('login-form');
    els.loginEmail = document.getElementById('login-email');
    els.loginPassword = document.getElementById('login-password');
    els.loginError = document.getElementById('login-error');
    els.newPasswordForm = document.getElementById('new-password-form');
    els.newPassword = document.getElementById('new-password');
    els.newPasswordConfirm = document.getElementById('new-password-confirm');
    els.newPasswordError = document.getElementById('new-password-error');
    els.app = document.getElementById('app');
    els.formsTableBody = document.getElementById('forms-table-body');
    els.newFormBtn = document.getElementById('new-form-btn');
    els.formEditor = document.getElementById('form-editor');
    els.formEditorTitle = document.getElementById('form-editor-title');
    els.editorFormId = document.getElementById('editor-form-id');
    els.editorFormName = document.getElementById('editor-form-name');
    els.editorNotificationEmail = document.getElementById('editor-notification-email');
    els.editorEmailNotificationsEnabled = document.getElementById('editor-email-notifications-enabled');
    els.editorOneSubmissionPerIp = document.getElementById('editor-one-submission-per-ip');
    els.editorEnabled = document.getElementById('editor-enabled');
    els.editorSaveBtn = document.getElementById('editor-save-btn');
    els.editorCancelBtn = document.getElementById('editor-cancel-btn');
    els.editorError = document.getElementById('editor-error');
  }

  function getIdToken() {
    return sessionStorage.getItem(ID_TOKEN_KEY);
  }

  function setIdToken(token) {
    sessionStorage.setItem(ID_TOKEN_KEY, token);
  }

  function clearIdToken() {
    sessionStorage.removeItem(ID_TOKEN_KEY);
  }

  function showLogin() {
    els.loginSection.hidden = false;
    els.app.hidden = true;
    els.signOutBtn.hidden = true;
    els.newPasswordForm.hidden = true;
    els.loginForm.hidden = false;
  }

  function showApp() {
    els.loginSection.hidden = true;
    els.app.hidden = false;
    els.signOutBtn.hidden = false;
  }

  // ---- Cognito authentication (plain fetch, no client libraries) ----

  function cognitoRequest(target, payload) {
    return fetch(cognitoEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.' + target,
      },
      body: JSON.stringify(payload),
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) {
          var err = new Error(data && data.message ? data.message : 'Request failed');
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function signIn(email, password) {
    return cognitoRequest('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: config.clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password,
      },
    }).then(handleAuthResult);
  }

  function respondToNewPasswordChallenge(newPassword) {
    if (!pendingChallenge) {
      return Promise.reject(new Error('No password challenge is in progress'));
    }
    return cognitoRequest('RespondToAuthChallenge', {
      ChallengeName: pendingChallenge.challengeName,
      ClientId: config.clientId,
      Session: pendingChallenge.session,
      ChallengeResponses: {
        USERNAME: pendingChallenge.username,
        NEW_PASSWORD: newPassword,
      },
    }).then(handleAuthResult);
  }

  function handleAuthResult(data) {
    if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
      pendingChallenge = {
        challengeName: data.ChallengeName,
        session: data.Session,
        username: els.loginEmail.value,
      };
      els.loginForm.hidden = true;
      els.newPasswordForm.hidden = false;
      return;
    }

    if (data.AuthenticationResult && data.AuthenticationResult.IdToken) {
      setIdToken(data.AuthenticationResult.IdToken);
      pendingChallenge = null;
      showApp();
      loadForms();
      return;
    }

    throw new Error('Unexpected authentication response');
  }

  // ---- Admin API ----

  function api(path, options) {
    var opts = options || {};
    var headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + getIdToken(),
    };
    if (opts.headers) {
      for (var key in opts.headers) {
        if (Object.prototype.hasOwnProperty.call(opts.headers, key)) {
          headers[key] = opts.headers[key];
        }
      }
    }

    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
    }).then(function (response) {
      if (response.status === 401) {
        clearIdToken();
        showLogin();
        throw new Error('Session expired, please sign in again');
      }
      if (response.status === 204) {
        return null;
      }
      return response.json().then(function (data) {
        if (!response.ok) {
          var err = new Error(data && data.message ? data.message : 'Request failed');
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  // ---- Forms list ----

  function loadForms() {
    return api('/api/forms').then(function (data) {
      renderFormsTable((data && data.forms) || []);
    });
  }

  function renderFormsTable(forms) {
    els.formsTableBody.textContent = '';
    forms.forEach(function (form) {
      els.formsTableBody.appendChild(buildFormRow(form));
    });
  }

  function textCell(text) {
    var td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  function buildFormRow(form) {
    var tr = document.createElement('tr');
    tr.appendChild(textCell(form.formId));
    tr.appendChild(textCell(form.formName));
    tr.appendChild(textCell(form.notificationEmail || ''));
    tr.appendChild(textCell(form.emailNotificationsEnabled ? 'On' : 'Off'));
    tr.appendChild(textCell(form.oneSubmissionPerIp ? 'On' : 'Off'));
    tr.appendChild(textCell(form.enabled ? 'Yes' : 'No'));

    var actionsTd = document.createElement('td');

    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', function () {
      openEditor(form);
    });
    actionsTd.appendChild(editBtn);

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () {
      deleteForm(form.formId);
    });
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    return tr;
  }

  function deleteForm(formId) {
    if (!window.confirm('Delete form "' + formId + '"? This cannot be undone.')) {
      return;
    }
    api('/api/forms/' + encodeURIComponent(formId), { method: 'DELETE' })
      .then(loadForms)
      .catch(function (err) {
        window.alert(err.message);
      });
  }

  // ---- Form editor ----

  var editingFormId = null;

  function openEditor(form) {
    els.editorError.textContent = '';
    editingFormId = form ? form.formId : null;
    els.formEditorTitle.textContent = form ? 'Edit form' : 'New form';
    els.editorFormId.value = form ? form.formId : '';
    els.editorFormId.disabled = !!form;
    els.editorFormName.value = form ? form.formName : '';
    els.editorNotificationEmail.value = form ? form.notificationEmail || '' : '';
    els.editorEmailNotificationsEnabled.checked = form ? !!form.emailNotificationsEnabled : false;
    els.editorOneSubmissionPerIp.checked = form ? !!form.oneSubmissionPerIp : false;
    els.editorEnabled.checked = form ? !!form.enabled : true;
    els.formEditor.hidden = false;
  }

  function closeEditor() {
    els.formEditor.hidden = true;
    editingFormId = null;
    els.formEditor.reset();
    els.editorError.textContent = '';
  }

  function saveForm(event) {
    event.preventDefault();
    els.editorError.textContent = '';

    var formId = editingFormId || els.editorFormId.value.trim();
    var body = {
      formName: els.editorFormName.value,
      notificationEmail: els.editorNotificationEmail.value || undefined,
      emailNotificationsEnabled: els.editorEmailNotificationsEnabled.checked,
      oneSubmissionPerIp: els.editorOneSubmissionPerIp.checked,
      enabled: els.editorEnabled.checked,
    };

    api('/api/forms/' + encodeURIComponent(formId), {
      method: 'PUT',
      body: JSON.stringify(body),
    })
      .then(function () {
        closeEditor();
        return loadForms();
      })
      .catch(function (err) {
        var messages = (err.data && err.data.errors) || [err.message];
        els.editorError.textContent = messages.join(' ');
      });
  }

  // ---- Wiring ----

  function onLoginSubmit(event) {
    event.preventDefault();
    els.loginError.textContent = '';
    signIn(els.loginEmail.value, els.loginPassword.value).catch(function (err) {
      els.loginError.textContent = err.message;
    });
  }

  function onNewPasswordSubmit(event) {
    event.preventDefault();
    els.newPasswordError.textContent = '';
    if (els.newPassword.value !== els.newPasswordConfirm.value) {
      els.newPasswordError.textContent = 'Passwords do not match';
      return;
    }
    respondToNewPasswordChallenge(els.newPassword.value).catch(function (err) {
      els.newPasswordError.textContent = err.message;
    });
  }

  function onSignOut() {
    clearIdToken();
    showLogin();
  }

  function init() {
    cacheElements();

    els.loginForm.addEventListener('submit', onLoginSubmit);
    els.newPasswordForm.addEventListener('submit', onNewPasswordSubmit);
    els.signOutBtn.addEventListener('click', onSignOut);
    els.newFormBtn.addEventListener('click', function () {
      openEditor(null);
    });
    els.formEditor.addEventListener('submit', saveForm);
    els.editorCancelBtn.addEventListener('click', closeEditor);

    if (getIdToken()) {
      showApp();
      loadForms().catch(function () {
        // api() already shows the login form on a 401; other failures are
        // left visible via the (empty) forms table for the user to retry.
      });
    } else {
      showLogin();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
