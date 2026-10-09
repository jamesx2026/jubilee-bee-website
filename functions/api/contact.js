/**
 * POST /api/contact
 *
 * Receives the contact form submission on our own origin, so a visitor's browser
 * never talks to a third-party domain (strict privacy modes, ad blockers and
 * corporate networks can silently break cross-origin posts to Google).
 *
 * The actual email delivery is unchanged: this Function forwards the submission
 * server-side to the existing Google Apps Script endpoint, then reports a
 * truthful result back to the page and logs every attempt.
 *
 * Routing: /functions/api/contact.js -> POST /api/contact
 */

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbzNh76tue4AsBSUuFw2aXDUYJ0ZASkQrJscudaYmWMjuHVHKFj7W6V81yG5zahN6UDHFg/exec';

const LIMITS = { name: 120, email: 160, message: 5000, howHeard: 60 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Friendly labels for the "how did you find me" dropdown, so the email James
// receives reads "Wedding Show / Expo" rather than the raw value "wedding-show".
// Keys must match the <option value="..."> values in contact.html.
const HOW_HEARD_LABELS = {
  'instagram': 'Instagram',
  'google': 'Google Search',
  'referral': 'Friend / Referral',
  'wedding-show': 'Wedding Show / Expo',
  'vendor': 'Wedding Vendor',
  'other': 'Other'
};
const howHeardLabel = (value) => HOW_HEARD_LABELS[value] || value;

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function wantsJson(request) {
  return (request.headers.get('accept') || '').includes('application/json');
}

/**
 * Respond either as JSON (JS-enabled fetch) or with a friendly redirect for a
 * plain form POST when JavaScript is unavailable.
 */
function respond(request, status, ok, error) {
  if (wantsJson(request)) return jsonResponse({ ok, error: error || null }, status);
  const url = new URL(request.url);
  url.pathname = '/contact.html';
  url.search = ok ? '?sent=1' : '?error=1';
  return Response.redirect(url.toString(), 303);
}

function log(event) {
  console.log(JSON.stringify(event));
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    log({ event: 'contact_bad_payload', error: String((err && err.message) || err) });
    return respond(request, 400, false, 'We could not read the form data.');
  }

  const value = (key) => (form.get(key) || '').toString().trim();
  const name = value('name');
  const email = value('email');
  const message = value('message');
  const howHeard = value('how-heard');
  const honeypot = value('company'); // hidden field — humans never fill this

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  if (!name || !email || !message) {
    return respond(request, 400, false, 'Please fill in your name, email and message.');
  }
  if (!EMAIL_RE.test(email)) {
    return respond(request, 400, false, 'That email address looks incorrect.');
  }
  if (name.length > LIMITS.name || email.length > LIMITS.email ||
      message.length > LIMITS.message || howHeard.length > LIMITS.howHeard) {
    return respond(request, 400, false, 'That message is a little too long — please shorten it.');
  }

  // Bot trap: accept quietly, forward nothing
  if (honeypot) {
    log({ event: 'contact_blocked_honeypot', ip });
    return respond(request, 200, true, null);
  }

  const payload = new URLSearchParams({
    name,
    email,
    message,
    'how-heard': howHeardLabel(howHeard)
  });

  let upstreamStatus = 0;
  try {
    const upstream = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: 'follow'
    });
    upstreamStatus = upstream.status;
    if (!upstream.ok) {
      log({ event: 'contact_upstream_rejected', status: upstreamStatus, name, email, ip });
      return respond(request, 502, false, 'The message service did not accept the submission.');
    }
  } catch (err) {
    log({
      event: 'contact_upstream_exception',
      error: String((err && err.message) || err),
      name, email, ip
    });
    return respond(request, 502, false, 'We could not reach the message service.');
  }

  // Full submission record — visible via `wrangler pages deployment tail` or dashboard logs
  log({
    event: 'contact_submitted',
    name, email, howHeard,
    messageLength: message.length,
    upstreamStatus,
    ip,
    userAgent: request.headers.get('user-agent') || 'unknown'
  });

  return respond(request, 200, true, null);
}
