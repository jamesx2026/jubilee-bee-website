/**
 * POST /api/contact
 *
 * Receives the contact form submission on our own origin, so a visitor's browser
 * never talks to a third-party domain (strict privacy modes, ad blockers and
 * corporate networks can silently break cross-origin posts to Google).
 *
 * Recipient: jingyang14@gmail.com  (per James, Oct 9 2026)
 *
 * Email delivery strategy:
 *   1. If APPS_SCRIPT_URL is configured, forward server-side to that Google Apps
 *      Script.  James can deploy a tiny Apps Script that sends to
 *      jingyang14@gmail.com (instructions in DEPLOYING_THE_APPS_SCRIPT below).
 *   2. If APPS_SCRIPT_URL is not configured (empty string), the form still
 *      responds 200, and the browser falls back to a mailto: link to
 *      jingyang14@gmail.com with the message pre-filled.  This way the form
 *      NEVER silently drops a submission.
 *
 * Routing: /functions/api/contact.js -> POST /api/contact
 */

const RECIPIENT_EMAIL = 'jingyang14@gmail.com';

// To set up real server-side email delivery, deploy a Google Apps Script web
// app with the doPost() handler shown in DEPLOYING_THE_APPS_SCRIPT below, then
// paste the deployed URL here.  Leave as '' to use the mailto: fallback only.
const APPS_SCRIPT_URL = '';

const LIMITS = { name: 120, email: 160, message: 5000, howHeard: 60, date: 40 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

function buildMailto({ name, email, message, date, phone, howHeard }) {
  const subject = `Jubilee Bee inquiry from ${name || 'someone'}`;
  const body = [
    `Name: ${name}`,
    `Email: ${email}`,
    phone ? `Phone: ${phone}` : null,
    date ? `Wedding date: ${date}` : null,
    howHeard ? `How they heard about us: ${howHeard}` : null,
    '',
    message
  ].filter(Boolean).join('\n');
  const params = new URLSearchParams({ subject, body });
  return `mailto:${RECIPIENT_EMAIL}?${params.toString()}`;
}

function respond(request, status, ok, error, mailto) {
  const body = { ok, error: error || null, mailto: mailto || null };
  if (wantsJson(request)) return jsonResponse(body, status);
  const url = new URL(request.url);
  url.pathname = '/contact.html';
  if (ok) {
    url.search = mailto ? `?sent=1&mailto=${encodeURIComponent(mailto)}` : '?sent=1';
  } else {
    url.search = '?error=1';
  }
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
  const phone = value('phone');
  const date = value('date');
  const howHeard = value('how-heard');
  const honeypot = value('company'); // hidden field - humans never fill this

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  if (!name || !email || !message) {
    return respond(request, 400, false, 'Please fill in your name, email and message.');
  }
  if (!EMAIL_RE.test(email)) {
    return respond(request, 400, false, 'That email address looks incorrect.');
  }
  if (name.length > LIMITS.name || email.length > LIMITS.email ||
      message.length > LIMITS.message || howHeard.length > LIMITS.howHeard ||
      date.length > LIMITS.date) {
    return respond(request, 400, false, 'That message is a little too long - please shorten it.');
  }

  // Bot trap: accept quietly, forward nothing
  if (honeypot) {
    log({ event: 'contact_blocked_honeypot', ip });
    return respond(request, 200, true, null);
  }

  // Strategy 1: server-side forward to Google Apps Script (if configured)
  if (APPS_SCRIPT_URL) {
    const payload = new URLSearchParams({
      name, email, message, phone, date, 'how-heard': howHeard,
      recipient: RECIPIENT_EMAIL
    });
    try {
      const upstream = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        body: payload,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'follow'
      });
      if (upstream.ok) {
        log({ event: 'contact_submitted', name, email, howHeard, messageLength: message.length, upstreamStatus: upstream.status, ip, recipient: RECIPIENT_EMAIL });
        return respond(request, 200, true, null);
      }
      log({ event: 'contact_upstream_rejected', status: upstream.status, name, email, ip });
      // fall through to mailto fallback
    } catch (err) {
      log({ event: 'contact_upstream_exception', error: String((err && err.message) || err), name, email, ip });
      // fall through to mailto fallback
    }
  }

  // Strategy 2: mailto: fallback - never silently drop a submission
  const mailto = buildMailto({ name, email, message, phone, date, howHeard });
  log({ event: 'contact_mailto_fallback', name, email, ip, recipient: RECIPIENT_EMAIL });
  return respond(request, 200, true, null, mailto);
}

/*
 * DEPLOYING_THE_APPS_SCRIPT (optional - only needed for server-side delivery
 * without the mailto fallback):
 *
 * 1. Open https://sheets.google.com -> Extensions -> Apps Script
 * 2. Paste this into Code.gs:
 *
 *    function doPost(e) {
 *      var p = e.parameter;
 *      var recipient = p.recipient || 'jingyang14@gmail.com';
 *      var subject = 'Jubilee Bee inquiry from ' + p.name;
 *      var body = [
 *        'Name: ' + p.name,
 *        'Email: ' + p.email,
 *        p.phone ? 'Phone: ' + p.phone : null,
 *        p.date ? 'Wedding date: ' + p.date : null,
 *        p['how-heard'] ? 'How they heard about us: ' + p['how-heard'] : null,
 *        '',p.message
 *      ].filter(Boolean).join('\n');
 *      MailApp.sendEmail({
 *        to: recipient,
 *        replyTo: p.email,
 *        subject: subject,
 *        body: body
 *      });
 *      return ContentService.createTextOutput('OK');
 *    }
 *
 * 3. Deploy -> New deployment -> Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy the deployment URL and paste it as APPS_SCRIPT_URL above.
 * 5. Redeploy the Cloudflare Pages site.
 */
