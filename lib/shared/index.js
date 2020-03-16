// @flow

const net = require('net')

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
  socket /*: Socket */,
  data /*: Buffer */,
  code /*: number */,
  protocol /*: string */ = 'http',
  message /*: string */
) {
  if (protocol === 'http') {
    socket.end(`HTTP/1.1 ${code} ${message}\n\n`)
  } else {
    const tunnelToResponder = new net.Socket()
    tunnelToResponder.connect(INTERNAL_HTTPS_RESPONDER_PORT, '127.0.0.1')

    tunnelToResponder.write(data)
    tunnelToResponder.pipe(socket).pipe(tunnelToResponder)

    socket.on('close', () => {
      tunnelToResponder.end()
    })
    tunnelToResponder.on('close', () => {
      socket.end()
    })
  }
}

module.exports = {
  setPTimeout,
  hasOwnProperty,
  sampleArray,
  writeHeader
}
