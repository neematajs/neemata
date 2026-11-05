// Stand-in for the nitro `node` preset entry: echoes what reached it so
// specs can prove a request fell through the static layer untouched.
export function listener(req, res) {
  // `/slow` stays in flight long enough for a spec to stop the server meanwhile.
  if (req.url === '/slow') {
    setTimeout(() => respond(req, res), 200)
    return
  }
  respond(req, res)
}

function respond(req, res) {
  const body = JSON.stringify({ method: req.method, url: req.url })
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}
