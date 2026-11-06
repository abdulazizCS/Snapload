'use strict';

// Content-Security-Policy for the site's own pages. No inline scripts or
// inline style attributes; only Google Fonts as an outside source.
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Downloaded files are user content: never let a browser run or render them.
const DOWNLOAD_CSP = "default-src 'none'; sandbox";

const isHttps = (req) => req.secure; // honours X-Forwarded-Proto via trust proxy

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', PAGE_CSP + (isHttps(req) ? '; upgrade-insecure-requests' : ''));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// Block other websites from posting uploads through visitors' browsers.
// Uses Sec-Fetch-Site (sent by all modern browsers), so it does not depend
// on how the proxy rewrites Host. Requests without it (curl, scripts) pass.
function sameOrigin(req, res, next) {
  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'طلب مرفوض' });
  }
  next();
}

module.exports = { securityHeaders, sameOrigin, DOWNLOAD_CSP };
