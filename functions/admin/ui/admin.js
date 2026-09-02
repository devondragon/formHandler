(function () {
  'use strict';

  // `document.currentScript` is only this script element while the script is
  // running synchronously, so read it first, before anything else. The Lambda
  // renders the Cognito config into the tag's data-config attribute; the page
  // has no inline script, so it can be served under script-src 'self'.
  var scriptEl = document.currentScript;

  function readConfig() {
    var raw = scriptEl && scriptEl.dataset ? scriptEl.dataset.config : null;
    if (!raw) {
      return {};
    }
    try {
      return JSON.parse(raw) || {};
    } catch (err) {
      // Nothing on the page can recover from this, but a silent empty config
      // shows up later as an unexplained Cognito failure; say so in the console.
      console.warn('Could not parse the admin config data attribute', err);
      return {};
    }
  }

  var ID_TOKEN_KEY = 'formHandlerAdminIdToken';
  var config = readConfig();
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
    els.newPasswordSubmitBtn = document.getElementById('new-password-submit-btn');
    els.newPasswordError = document.getElementById('new-password-error');
    els.app = document.getElementById('app');
    els.formsTableBody = document.getElementById('forms-table-body');
    els.loginSubmitBtn = document.getElementById('login-submit-btn');
    els.formsError = document.getElementById('forms-error');
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
    els.submissionsSection = document.getElementById('submissions-section');
    els.submissionsBackBtn = document.getElementById('submissions-back-btn');
    els.submissionsTitle = document.getElementById('submissions-title');
    els.submissionsFilters = document.getElementById('submissions-filters');
    els.submissionsFrom = document.getElementById('submissions-from');
    els.submissionsTo = document.getElementById('submissions-to');
    els.submissionsSearch = document.getElementById('submissions-search');
    els.submissionsApplyBtn = document.getElementById('submissions-apply-btn');
    els.exportCsvBtn = document.getElementById('export-csv-btn');
    els.exportJsonBtn = document.getElementById('export-json-btn');
    els.submissionsError = document.getElementById('submissions-error');
    els.submissionsEmpty = document.getElementById('submissions-empty');
    els.submissionsTable = document.getElementById('submissions-table');
    els.submissionsHeadRow = document.getElementById('submissions-head-row');
    els.submissionsTableBody = document.getElementById('submissions-table-body');
    els.submissionsLoadMoreBtn = document.getElementById('submissions-load-more-btn');
    // Captured from the static markup so the default empty-state message
    // matches ui/index.html without duplicating the string here.
    submissionsEmptyDefaultText = els.submissionsEmpty ? els.submissionsEmpty.textContent : '';
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
    if (els.submissionsSection) {
      els.submissionsSection.hidden = true;
    }
    els.signOutBtn.hidden = true;
    els.newPasswordForm.hidden = true;
    els.loginForm.hidden = false;
    els.loginForm.reset();
    pendingChallenge = null;
  }

  function showApp() {
    els.loginSection.hidden = true;
    els.app.hidden = false;
    if (els.submissionsSection) {
      els.submissionsSection.hidden = true;
    }
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
          // Cognito's error responses spell the field "message"; some other
          // AWS error shapes use "Message" instead.
          var errorMessage = (data && (data.message || data.Message)) || 'Request failed';
          var err = new Error(errorMessage);
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
      // The pool uses email as a username attribute, so the account's real
      // username is a Cognito-generated id, not the address that was typed in.
      // InitiateAuth returns it as USER_ID_FOR_SRP, and RespondToAuthChallenge
      // must echo that value back as USERNAME; sending the email instead makes
      // Cognito reject the challenge response.
      pendingChallenge = {
        challengeName: data.ChallengeName,
        session: data.Session,
        username:
          (data.ChallengeParameters && data.ChallengeParameters.USER_ID_FOR_SRP) ||
          els.loginEmail.value,
      };
      els.loginForm.hidden = true;
      els.newPasswordForm.hidden = false;
      return;
    }

    if (data.AuthenticationResult && data.AuthenticationResult.IdToken) {
      setIdToken(data.AuthenticationResult.IdToken);
      pendingChallenge = null;
      showApp();
      return loadForms();
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
          var errorMessage = (data && (data.message || data.Message)) || 'Request failed';
          var err = new Error(errorMessage);
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  // ---- Forms list ----

  function loadForms() {
    return api('/api/forms')
      .then(function (data) {
        els.formsError.textContent = '';
        renderFormsTable((data && data.forms) || []);
      })
      .catch(function (err) {
        els.formsError.textContent = err.message;
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

    var submissionsBtn = document.createElement('button');
    submissionsBtn.type = 'button';
    submissionsBtn.textContent = 'Submissions';
    submissionsBtn.addEventListener('click', function () {
      openSubmissions(form);
    });
    actionsTd.appendChild(submissionsBtn);

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () {
      deleteForm(form.formId, deleteBtn);
    });
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    return tr;
  }

  function deleteForm(formId, buttonEl) {
    if (!window.confirm('Delete form "' + formId + '"? This cannot be undone.')) {
      return;
    }
    buttonEl.disabled = true;
    api('/api/forms/' + encodeURIComponent(formId), { method: 'DELETE' })
      .then(loadForms)
      .catch(function (err) {
        window.alert(err.message);
      })
      .finally(function () {
        buttonEl.disabled = false;
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
    els.editorSaveBtn.disabled = true;

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
      })
      .finally(function () {
        els.editorSaveBtn.disabled = false;
      });
  }

  // ---- Submissions ----

  // Column order: the two columns every submission has, then the submitted
  // fields sorted by field name, then the bookkeeping attributes.
  var LEADING_COLUMNS = ['timestamp', 'sourceIP'];
  var TRAILING_COLUMNS = ['id', 'forwardedFor', 'formId'];

  // Shown in the empty-state element instead of the "no matches" message when
  // a page came back with zero rows but more of the partition is still
  // unscanned (a search term filtered out everything on this page, but later
  // pages might still match). Set in cacheElements() from the static markup.
  var submissionsEmptyDefaultText = '';
  var SUBMISSIONS_SCANNING_MESSAGE =
    'No matches yet in the scanned range. Click Load more to continue.';

  // The form whose submissions are on screen, the rows loaded so far (they
  // accumulate as "Load more" is clicked), and the cursor for the next page.
  var submissionsForm = null;
  var submissionRows = [];
  var submissionsCursor = null;

  // The filter values the loaded rows were fetched with. "Load more" sends
  // these rather than re-reading the inputs, so editing a filter without
  // clicking Apply cannot page a different result set onto the current one.
  var appliedFilters = { from: '', to: '', q: '' };

  // Requests in flight, and an id identifying the newest list request. "Back to
  // forms" is clickable while a request is in flight, so a response can arrive
  // after the view has moved to another form; anything but the newest id is a
  // response for a form that is no longer on screen and is discarded.
  var submissionsPending = 0;
  var submissionsRequestId = 0;

  function setDisabled(el, disabled) {
    if (el) {
      el.disabled = disabled;
    }
  }

  function beginSubmissionsRequest() {
    submissionsPending += 1;
    updateSubmissionsButtons();
  }

  function endSubmissionsRequest() {
    submissionsPending = Math.max(0, submissionsPending - 1);
    updateSubmissionsButtons();
  }

  function updateSubmissionsButtons() {
    var busy = submissionsPending > 0;
    setDisabled(els.submissionsApplyBtn, busy);
    setDisabled(els.submissionsLoadMoreBtn, busy);
    setDisabled(els.exportCsvBtn, busy);
    setDisabled(els.exportJsonBtn, busy);
  }

  /** Builds a query string, dropping empty and absent values. */
  function buildQuery(params) {
    var parts = [];
    Object.keys(params).forEach(function (key) {
      var value = params[key];
      if (value !== undefined && value !== null && value !== '') {
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
      }
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function submissionFilters() {
    return {
      from: els.submissionsFrom ? els.submissionsFrom.value : '',
      to: els.submissionsTo ? els.submissionsTo.value : '',
      q: els.submissionsSearch ? els.submissionsSearch.value.trim() : '',
    };
  }

  function setSubmissionsError(message) {
    if (els.submissionsError) {
      els.submissionsError.textContent = message;
    }
  }

  function openSubmissions(form) {
    if (!els.submissionsSection) {
      return;
    }
    submissionsForm = form;
    submissionRows = [];
    submissionsCursor = null;
    appliedFilters = { from: '', to: '', q: '' };
    if (els.submissionsFilters) {
      els.submissionsFilters.reset();
    }
    setSubmissionsError('');
    if (els.submissionsTitle) {
      els.submissionsTitle.textContent = 'Submissions: ' + form.formName;
    }
    els.app.hidden = true;
    els.submissionsSection.hidden = false;
    clearSubmissionsTable();
    loadSubmissions(false);
  }

  /**
   * Empties the table without deciding whether the result set is empty: the
   * "no submissions" message would otherwise flash while the first page loads.
   */
  function clearSubmissionsTable() {
    if (els.submissionsHeadRow) {
      els.submissionsHeadRow.textContent = '';
    }
    if (els.submissionsTableBody) {
      els.submissionsTableBody.textContent = '';
    }
    if (els.submissionsTable) {
      els.submissionsTable.hidden = true;
    }
    if (els.submissionsEmpty) {
      els.submissionsEmpty.hidden = true;
    }
    if (els.submissionsLoadMoreBtn) {
      els.submissionsLoadMoreBtn.hidden = true;
    }
  }

  function backToForms() {
    if (els.submissionsSection) {
      els.submissionsSection.hidden = true;
    }
    els.app.hidden = false;
    submissionsForm = null;
  }

  function submissionsPath(suffix, params) {
    return (
      '/api/forms/' +
      encodeURIComponent(submissionsForm.formId) +
      '/submissions' +
      suffix +
      buildQuery(params)
    );
  }

  /** Loads a page of submissions, appending to the loaded rows when paging. */
  function loadSubmissions(append) {
    if (!submissionsForm) {
      return;
    }
    if (!append) {
      // A fresh load replaces the result set, so the old cursor belongs to a
      // scan that is about to be discarded. Drop it and hide the button before
      // the request goes out, so a click while it is in flight cannot append a
      // page of the previous result set.
      submissionsCursor = null;
      if (els.submissionsLoadMoreBtn) {
        els.submissionsLoadMoreBtn.hidden = true;
      }
    }
    var filters = append ? appliedFilters : submissionFilters();
    var path = submissionsPath('', {
      from: filters.from,
      to: filters.to,
      q: filters.q,
      cursor: append ? submissionsCursor : '',
    });
    var requestId = ++submissionsRequestId;

    setSubmissionsError('');
    beginSubmissionsRequest();
    api(path)
      .then(function (data) {
        if (requestId !== submissionsRequestId) {
          return;
        }
        if (!append) {
          appliedFilters = filters;
        }
        var rows = (data && data.submissions) || [];
        submissionRows = append ? submissionRows.concat(rows) : rows;
        submissionsCursor = (data && data.nextCursor) || null;
        renderSubmissions();
      })
      .catch(function (err) {
        if (requestId !== submissionsRequestId) {
          return;
        }
        setSubmissionsError(err.message);
      })
      .finally(function () {
        endSubmissionsRequest();
      });
  }

  /** The union of the attribute names across the loaded rows, in display order. */
  function submissionColumns(rows) {
    var seen = Object.create(null);
    rows.forEach(function (row) {
      Object.keys(row || {}).forEach(function (key) {
        seen[key] = true;
      });
    });

    var middle = Object.keys(seen)
      .filter(function (key) {
        return LEADING_COLUMNS.indexOf(key) === -1 && TRAILING_COLUMNS.indexOf(key) === -1;
      })
      .sort();
    var trailing = TRAILING_COLUMNS.filter(function (key) {
      return seen[key];
    });

    return LEADING_COLUMNS.concat(middle, trailing);
  }

  /** Submitted values can be any JSON type; render non-strings as JSON. */
  function submissionCellText(row, key) {
    if (!row || !Object.prototype.hasOwnProperty.call(row, key)) {
      return '';
    }
    var value = row[key];
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    var text = JSON.stringify(value);
    return text === undefined ? '' : text;
  }

  function renderSubmissions() {
    if (!els.submissionsHeadRow || !els.submissionsTableBody) {
      return;
    }

    var columns = submissionColumns(submissionRows);

    els.submissionsHeadRow.textContent = '';
    columns.forEach(function (name) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = name;
      els.submissionsHeadRow.appendChild(th);
    });

    els.submissionsTableBody.textContent = '';
    submissionRows.forEach(function (row) {
      var tr = document.createElement('tr');
      columns.forEach(function (name) {
        tr.appendChild(textCell(submissionCellText(row, name)));
      });
      els.submissionsTableBody.appendChild(tr);
    });

    var isEmpty = submissionRows.length === 0;
    // Zero rows with a cursor means the scan has more of the partition left
    // to look at, not that the search has no matches; say so instead of
    // showing the "no matches" message, and leave Load more up so the caller
    // can keep going.
    var stillScanning = isEmpty && !!submissionsCursor;
    if (els.submissionsTable) {
      els.submissionsTable.hidden = isEmpty;
    }
    if (els.submissionsEmpty) {
      els.submissionsEmpty.hidden = !isEmpty;
      els.submissionsEmpty.textContent = stillScanning
        ? SUBMISSIONS_SCANNING_MESSAGE
        : submissionsEmptyDefaultText;
    }
    if (els.submissionsLoadMoreBtn) {
      els.submissionsLoadMoreBtn.hidden = !submissionsCursor;
    }
  }

  // ---- Exports ----

  // Shown when the response carries X-Truncated: the file saved, but the server
  // dropped rows past one of its export caps.
  var EXPORT_TRUNCATED_MESSAGE =
    'Export capped (10,000 rows or 5 MB). Narrow the date range to get the rest.';

  function filenameFromDisposition(header, fallback) {
    var match = header ? /filename="([^"]+)"/i.exec(header) : null;
    return match ? match[1] : fallback;
  }

  /**
   * Saves a blob by clicking a temporary anchor. The object URL is revoked on
   * the next tick rather than immediately, because some browsers start the
   * download asynchronously and would otherwise find the URL already gone.
   */
  function saveBlob(blob, filename) {
    var objectUrl = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () {
      URL.revokeObjectURL(objectUrl);
    }, 0);
  }

  /**
   * Downloads an export. The response is a file rather than JSON, so it cannot
   * go through `api()`; the auth header and the 401 handling are repeated here.
   */
  function downloadExport(format) {
    if (!submissionsForm || submissionsPending > 0) {
      return;
    }
    var filters = submissionFilters();
    var path = submissionsPath('/export', {
      from: filters.from,
      to: filters.to,
      q: filters.q,
      format: format,
    });
    var fallbackName = submissionsForm.formId + '-submissions.' + format;

    setSubmissionsError('');
    beginSubmissionsRequest();
    fetch(path, {
      headers: { Authorization: 'Bearer ' + getIdToken() },
    })
      .then(function (response) {
        if (response.status === 401) {
          clearIdToken();
          showLogin();
          throw new Error('Session expired, please sign in again');
        }
        if (!response.ok) {
          return response.json().then(
            function (data) {
              throw new Error((data && (data.message || data.Message)) || 'Export failed');
            },
            function () {
              throw new Error('Export failed');
            }
          );
        }
        var filename = filenameFromDisposition(
          response.headers.get('Content-Disposition'),
          fallbackName
        );
        // Headers have to be read before the body is consumed.
        var truncated = response.headers.get('X-Truncated');
        return response.blob().then(function (blob) {
          saveBlob(blob, filename);
          if (truncated) {
            setSubmissionsError(EXPORT_TRUNCATED_MESSAGE);
          }
        });
      })
      .catch(function (err) {
        setSubmissionsError(err.message);
      })
      .finally(function () {
        endSubmissionsRequest();
      });
  }

  // ---- Wiring ----

  function onLoginSubmit(event) {
    event.preventDefault();
    els.loginError.textContent = '';
    els.loginSubmitBtn.disabled = true;
    signIn(els.loginEmail.value, els.loginPassword.value)
      .catch(function (err) {
        els.loginError.textContent = err.message;
      })
      .finally(function () {
        els.loginSubmitBtn.disabled = false;
      });
  }

  function onNewPasswordSubmit(event) {
    event.preventDefault();
    els.newPasswordError.textContent = '';
    if (els.newPassword.value !== els.newPasswordConfirm.value) {
      els.newPasswordError.textContent = 'Passwords do not match';
      return;
    }
    els.newPasswordSubmitBtn.disabled = true;
    respondToNewPasswordChallenge(els.newPassword.value)
      .catch(function (err) {
        els.newPasswordError.textContent = err.message;
      })
      .finally(function () {
        els.newPasswordSubmitBtn.disabled = false;
      });
  }

  function onSubmissionsFilterSubmit(event) {
    event.preventDefault();
    loadSubmissions(false);
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

    if (els.submissionsBackBtn) {
      els.submissionsBackBtn.addEventListener('click', backToForms);
    }
    if (els.submissionsFilters) {
      els.submissionsFilters.addEventListener('submit', onSubmissionsFilterSubmit);
    }
    if (els.submissionsLoadMoreBtn) {
      els.submissionsLoadMoreBtn.addEventListener('click', function () {
        loadSubmissions(true);
      });
    }
    if (els.exportCsvBtn) {
      els.exportCsvBtn.addEventListener('click', function () {
        downloadExport('csv');
      });
    }
    if (els.exportJsonBtn) {
      els.exportJsonBtn.addEventListener('click', function () {
        downloadExport('json');
      });
    }

    if (getIdToken()) {
      showApp();
      loadForms();
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
