/**
 * POST /api/contact
 *
 * Receives the contact form submission on our own origin and forwards it
 * server-side to Resend's API to send an email to jingyang14@gmail.com.
 *
 * No third-party domain is involved on the visitor's side, so privacy modes,
 * ad blockers and corporate networks can't break the submission.
 *
 * Sender: onboarding@resend.dev (until you verify jubileebee.com in Resend)
 * Recipient: jingyang14@gmail.com
 * Reply-To: the visitor's email (so replies go to the inquirer, not to Resend)
 *
 * Routing: /functions/api/contact.js -> POST /api/contact
 */

const RESEND_API_URL = 'https://api.resend.com/emails';
const RECIPIENT_EMAIL = 'jingyang14@gmail.com';
const SENDER_EMAIL = 'Jubilee Bee <onboarding@resend.dev>';

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

  // Bot trap: accept quietly, send nothing
  if (honeypot) {
    log({ event: 'contact_blocked_honeypot', ip });
    return respond(request, 200, true, null);
  }

  // Build the email body
  const textBody = [
    `Name: ${name}`,
    `Email: ${email}`,
    phone ? `Phone: ${phone}` : null,
    date ? `Wedding date: ${date}` : null,
    howHeard ? `How they heard about us: ${howHeard}` : null,
    '',
    message
  ].filter(Boolean).join('\n');

  const subject = `Jubilee Bee inquiry from ${name}`;
  const apiKey = context.env.RESEND_API_KEY;

  if (!apiKey) {
    log({ event: 'contact_no_api_key', ip });
    // Fallback to mailto so the form still works for the visitor
    const mailto = buildMailto({ name, email, message, phone, date, howHeard });
    return respond(request, 200, true, null, mailto);
  }

  // Send via Resend
  const resendPayload = {
    from: SENDER_EMAIL,
    to: RECIPIENT_EMAIL,
    reply_to: email,
    subject,
    text: textBody
  };

  let upstreamStatus = 0;
  try {
    const upstream = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(resendPayload)
    });
    upstreamStatus = upstream.status;
    const respText = await upstream.text();
    if (upstream.ok) {
      log({ event: 'contact_sent', name, email, howHeard, messageLength: message.length, upstreamStatus, ip, recipient: RECIPIENT_EMAIL });
      return respond(request, 200, true, null);
    }
    log({ event: 'contact_resend_rejected', status: upstreamStatus, name, email, response: respText[:500], ip });
    // Fall through to mailto fallback
  } catch (err) {
    log({ event: 'contact_resend_exception', error: String((err && err.message) || err), name, email, ip });
    // Fall through to mailto fallback
  }

  // mailto: fallback - never silently drop a submission
  const mailto = buildMailto({ name, email, message, phone, date, howHeard });
  return respond(request, 200, true, null, mailto);
}
