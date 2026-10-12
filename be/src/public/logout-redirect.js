// B4.7 front-channel logout: after giving the hidden RP iframes a moment to clear their own
// sessions, continue to the post-logout target. Static (served from /assets) so the intermediate
// page needs no inline script (CSP script-src 'self'). The IdP logout already completed serve
// side; this is best-effort UX only, so a slow/failed RP iframe never blocks the redirect.
(function () {
  var link = document.getElementById('logout-continue');
  if (!link) return;
  var target = link.getAttribute('data-target');
  if (!target) return;
  setTimeout(function () {
    window.location.replace(target);
  }, 2000);
})();

