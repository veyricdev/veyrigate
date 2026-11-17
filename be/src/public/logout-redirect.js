// B4.7 front-channel logout: after giving the hidden RP iframes a moment to clear their own
// sessions, continue to the post-logout target. Static (served from /assets) so the intermediate
// page needs no inline script (CSP script-src 'self'). The IdP logout already completed serve
// side; this is best-effort UX only, so a slow/failed RP iframe never blocks the redirect.
// CodeQL #2: the server already validated the target; still only ever navigate to http(s).
(function () {
  var link = document.getElementById('logout-continue');
  if (!link) return;
  var target = link.getAttribute('data-target');
  if (!target) return;
  var url;
  try {
    url = new URL(target, window.location.href);
  } catch (e) {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  setTimeout(function () {
    window.location.replace(url.href);
  }, 2000);
})();
