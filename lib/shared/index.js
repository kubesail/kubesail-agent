// @flow

const https = require('https')

const { INTERNAL_HTTPS_RESPONDER_PORT } = require('./config')

function setPTimeout(ms /*: number */) /*: Promise<any> */ {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function hasOwnProperty(obj /*: Object */, key /*: string */) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function sampleArray(arr /*: Array<any> */) {
  if (!arr || !arr.length) return undefined
  return arr[Math.floor(Math.random() * arr.length)]
}

function writeHeader(
  socket /*: Net.Socket */,
  code /*: number */,
  protocol /*: string */ = 'http',
  message /*: string */
) {
  if (protocol === 'http') {
    socket.end(`HTTP/1.1 ${code} ${message}\n\n`)
  } else {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: INTERNAL_HTTPS_RESPONDER_PORT,
        method: 'GET',
        path: `/${code}`
      },
      res => {
        res.pipe(socket)
      }
    )
    req.end()
  }
}

module.exports = {
  setPTimeout,
  hasOwnProperty,
  sampleArray,
  writeHeader
}
