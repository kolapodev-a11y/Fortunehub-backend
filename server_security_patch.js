/**
 * FortuneHub — server.js Security Headers Patch
 * ==============================================
 * Add this middleware block at the TOP of your Express app,
 * immediately after your `const app = express();` line and
 * BEFORE any route definitions or static file serving.
 *
 * These headers fix the Lighthouse Best Practices issues:
 *  ✅ CSP (High) — "No CSP found in enforcement mode"
 *  ✅ HSTS (Medium) — "No includeSubDomains / preload directive found"
 *  ✅ COOP (High) — "No COOP header found"
 *  ✅ Eliminates console errors / Issues panel warnings
 *
 * Also applies:
 *  ✅ X-Content-Type-Options  — prevents MIME-sniffing attacks
 *  ✅ X-Frame-Options          — prevents clickjacking
 *  ✅ Referrer-Policy          — limits referrer leakage
 *  ✅ Permissions-Policy       — disables unneeded browser features
 *
 * IMPORTANT NOTES:
 * ─────────────────────────────────────────────────────────────────
 * 1. COOP is set to "same-origin-allow-popups" (NOT "same-origin")
 *    because Paystack opens a checkout popup window. Using
 *    "same-origin" would break the Paystack payment flow.
 *
 * 2. The CSP allows:
 *    • js.paystack.co — Paystack SDK (loaded lazily now)
 *    • checkout.paystack.com — Paystack iframe
 *    • cdnjs.cloudflare.com — Font Awesome CSS + fonts
 *    • 'unsafe-inline' for style-src — needed for inline
 *      styles in modals/overlays (remove if you can refactor)
 *
 * 3. HSTS preload: only submit to the preload list AFTER you
 *    are 100% certain your domain will always use HTTPS.
 *    Remove "; preload" if you are not ready to submit.
 *
 * 4. Cache-Control for static assets: the line below sets a
 *    1-year cache on all /public (static) files. Adjust the
 *    path to match wherever your static files live.
 * ─────────────────────────────────────────────────────────────────
 */

// ──────────────────────────────────────────────────────────
// PASTE THIS BLOCK INTO server.js (right after `const app = express();`)
// ──────────────────────────────────────────────────────────

/*

// ✅ Security & Performance Headers Middleware
app.use((req, res, next) => {

  // ── HSTS ──────────────────────────────────────────────
  // Tells browsers to only access the site over HTTPS.
  // includeSubDomains: also applies to subdomains (e.g. checkout.*)
  // preload: allows submission to the HSTS preload list
  // LIGHTHOUSE FIX: "No includeSubDomains/preload directive found"
  res.setHeader(
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains; preload'
  );

  // ── COOP ──────────────────────────────────────────────
  // Isolates the browsing context so cross-origin windows
  // can't access this page's JS globals.
  // "same-origin-allow-popups" is used (not "same-origin")
  // so that the Paystack checkout popup still works.
  // LIGHTHOUSE FIX: "No COOP header found"
  res.setHeader(
    'Cross-Origin-Opener-Policy',
    'same-origin-allow-popups'
  );

  // ── CSP ───────────────────────────────────────────────
  // Content Security Policy limits which resources can load.
  // LIGHTHOUSE FIX: "No CSP found in enforcement mode"
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // Script sources: same origin + Paystack (lazy-loaded on checkout)
      "script-src 'self' https://js.paystack.co 'unsafe-inline'",
      // Style sources: same origin + Font Awesome CDN + inline styles
      "style-src 'self' https://cdnjs.cloudflare.com 'unsafe-inline'",
      // Font sources: same origin + Font Awesome CDN
      "font-src 'self' https://cdnjs.cloudflare.com",
      // Image sources: same origin + data URIs + any HTTPS image
      "img-src 'self' data: https:",
      // XHR/fetch: same origin + Paystack API + your Render backend
      "connect-src 'self' https://api.paystack.co https://fortunehub-backend.onrender.com",
      // Paystack checkout popup/iframe
      "frame-src https://checkout.paystack.com",
      // No objects/embeds needed
      "object-src 'none'",
      // Upgrade any accidental HTTP requests to HTTPS
      "upgrade-insecure-requests",
    ].join('; ')
  );

  // ── X-Content-Type-Options ────────────────────────────
  // Prevents browsers from MIME-sniffing the content-type.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ── X-Frame-Options ───────────────────────────────────
  // Prevents your site from being embedded in an iframe (anti-clickjacking).
  // Use SAMEORIGIN if you need self-embedding; DENY if not.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');

  // ── Referrer-Policy ───────────────────────────────────
  // Sends full referrer for same-origin, only origin for cross-origin.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // ── Permissions-Policy ────────────────────────────────
  // Disables browser features the shop doesn't need.
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(self "https://js.paystack.co")'
  );

  next();
});

// ✅ Cache-Control for static files (1 year for assets with hashes, no-cache for HTML)
// Adjust the path below to match your static files directory.
// If you serve static files with express.static, pass the options object:
//
//   app.use(express.static('public', {
//     maxAge: '1y',       // ← 1-year cache for CSS/JS/images
//     etag: true,
//     setHeaders: (res, filePath) => {
//       // HTML files should never be cached (so users get latest version)
//       if (filePath.endsWith('.html')) {
//         res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
//       }
//     },
//   }));
//
// LIGHTHOUSE FIX: "Use efficient cache lifetimes — Est savings 128 KiB"

*/

// ──────────────────────────────────────────────────────────
// END OF PASTE BLOCK
// ──────────────────────────────────────────────────────────
