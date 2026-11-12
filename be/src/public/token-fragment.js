// DEBT-577 (D86.2): the verify/reset link carries its one-time token in the fragment
// (`#token=<43>`), which the browser never sends, so it never reaches a request line, access log or
// Referer. Static (served from /assets) so the page needs no inline script (CSP script-src 'self').
// A matching fragment fills the single code field (`.value` only) and hides its label; any
// `#token=` fragment, valid or not, is then dropped from the address bar and history entry. Without
// JS, or with a missing/odd fragment, the field stays visible for the code printed in the mail.
(function () {
  var hash = window.location.hash;
  if (hash.indexOf('#token=') !== 0) return;
  var m = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash);
  var field = document.getElementById('token');
  var label = document.getElementById('token-manual');
  if (m && field && label) {
    field.value = m[1];
    label.hidden = true;
  }
  window.history.replaceState(null, '', window.location.pathname);
})();
