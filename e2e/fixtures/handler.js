/**
 * Request handler for the local E2E fixture.
 *
 * Nothing here is a wallet, a key, or a broadcaster. `/arc` refuses every
 * broadcast so an accidental Authorize cannot reach mainnet or testnet.
 * The secp generator point below is a public constant used as the 402
 * `x-bsv-server` identity, not a private key.
 */

const SERVER_IDENTITY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const SATS_ABOVE_AUTO_APPROVE = '250001'

const CLIENT = `
function e2e(status) {
  var payload = JSON.stringify({ type: 'E2E', status: status });
  function send() {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(payload);
      return true;
    }
    return false;
  }
  if (!send()) {
    var n = 0;
    var timer = setInterval(function () {
      if (send() || ++n > 50) clearInterval(timer);
    }, 100);
  }
}
function reportPath() {
  var path = (location.pathname || '/').replace(/^\\/+|\\/+$/g, '');
  e2e('page:' + (path || 'home'));
}
`

function page(title, body, extra) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font: 18px/1.4 system-ui, sans-serif; margin: 0; padding: 24px; background: #fff; color: #111; }
  h1 { font-size: 28px; margin: 0 0 12px; }
  p { margin: 0 0 12px; }
</style>
</head><body>
<h1>${title}</h1>
${body}
<script>${CLIENT}</script>
<script>${extra || 'reportPath();'}</script>
</body></html>`
}

function send(res, status, body, headers) {
  const payload = Buffer.from(body)
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...headers
  })
  res.end(payload)
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function hasPayment(req) {
  const headers = req.headers || {}
  return Boolean(headers['x-bsv-beef'] || headers['x-bsv-sender'])
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname

  if (path === '/arc' || path.startsWith('/arc/')) {
    sendJson(res, 403, {
      status: 'error',
      detail: 'e2e mock refuses to broadcast'
    })
    return
  }

  if (path === '/health') {
    send(res, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' })
    return
  }

  if (path === '/paid') {
    if (hasPayment(req)) {
      send(
        res,
        200,
        page('Paid content', '<p>The fixture accepted a payment header. No transaction was broadcast.</p>')
      )
      return
    }
    send(
      res,
      402,
      page('Payment required', '<p>This page answers 402 until a wallet pays. The e2e flow rejects the prompt.</p>'),
      {
        'x-bsv-sats': SATS_ABOVE_AUTO_APPROVE,
        'x-bsv-server': SERVER_IDENTITY
      }
    )
    return
  }

  if (path === '/' || path === '/home') {
    send(res, 200, page('E2E Home', '<p>Local fixture page for the browser suite.</p>'))
    return
  }

  if (path === '/article') {
    send(res, 200, page('E2E Article', '<p>A second page for tabs, bookmarks, and history.</p>'))
    return
  }

  if (path === '/deeplink') {
    send(res, 200, page('E2E Deep link', '<p>Opened from a deep link into the browser.</p>'))
    return
  }

  if (path === '/camera') {
    send(
      res,
      200,
      page(
        'E2E Camera',
        '<p>Requests the camera so the in-app permission sheet can be denied.</p>',
        `reportPath();
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          navigator.mediaDevices.getUserMedia({ video: true }).then(function () {
            e2e('camera:granted');
          }).catch(function () {
            e2e('camera:denied');
          });
        } else {
          e2e('camera:unavailable');
        }`
      )
    )
    return
  }

  if (path === '/protocol') {
    send(
      res,
      200,
      page(
        'E2E Protocol',
        '<p>Asks the wallet for a BRC-100 protocol key. Reject the prompt.</p>',
        `reportPath();
        var call = function () {
          if (!window.CWI || !window.CWI.getPublicKey) {
            e2e('protocol:unavailable');
            return;
          }
          window.CWI.getPublicKey({ protocolID: [2, 'e2e'], keyID: '1' }).then(function () {
            e2e('protocol:granted');
          }).catch(function () {
            e2e('protocol:rejected');
          });
        };
        setTimeout(call, 300);`
      )
    )
    return
  }

  if (path === '/certificate') {
    send(
      res,
      200,
      page(
        'E2E Certificate',
        '<p>Asks the wallet for a certificate. Reject the prompt. No certifier is contacted with funds.</p>',
        `reportPath();
        var call = function () {
          if (!window.CWI || !window.CWI.acquireCertificate) {
            e2e('certificate:unavailable');
            return;
          }
          window.CWI.acquireCertificate({
            type: 'dGVzdA==',
            certifier: '${'02' + '11'.repeat(32)}',
            acquisitionProtocol: 'direct',
            fields: { name: 'e2e' }
          }).then(function () {
            e2e('certificate:granted');
          }).catch(function () {
            e2e('certificate:rejected');
          });
        };
        setTimeout(call, 300);`
      )
    )
    return
  }

  if (path === '/spend') {
    send(
      res,
      200,
      page(
        'E2E Spend',
        '<p>Asks the wallet to create an action above the auto-approve threshold. Reject it. Nothing is broadcast.</p>',
        `reportPath();
        var call = function () {
          if (!window.CWI || !window.CWI.createAction) {
            e2e('spend:unavailable');
            return;
          }
          window.CWI.createAction({
            description: 'E2E spend',
            outputs: [{
              satoshis: ${Number(SATS_ABOVE_AUTO_APPROVE)},
              lockingScript: '76a914000000000000000000000000000000000000000088ac',
              outputDescription: 'e2e'
            }]
          }).then(function () {
            e2e('spend:granted');
          }).catch(function () {
            e2e('spend:rejected');
          });
        };
        setTimeout(call, 300);`
      )
    )
    return
  }

  send(res, 404, page('Not found', `<p>No fixture at ${path}.</p>`))
}

module.exports = {
  handle,
  page,
  SERVER_IDENTITY,
  SATS_ABOVE_AUTO_APPROVE
}
