// @flow

const fs = require('fs')

// Becomes unnecessary with Node 11, but kills node when a promise is rejected and unhandled
process.on('unhandledRejection', err => {
  throw err
})

function setPTimeout(ms /*: number */) /*: Promise<any> */ {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getRelease() {
  try {
    return fs.readFileSync('.release').toString()
  } catch (err) {
    return 'development'
  }
}

function hasOwnProperty(obj /*: Object */, key /*: string */) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function sampleArray(arr /*: Array<any> */) {
  if (!arr || !arr.length) return undefined
  return arr[Math.floor(Math.random() * arr.length)]
}

function writeHeader(code /*: number */, protocol /*: string */ = 'http', message /*: string */) {
  if (protocol === 'http') return `HTTP/1.1 ${code} ${message}\n\n`
  return ''
}

// Parses a string of URIs like: "host:port,host:port..."
// into an array of objects like: [ { host: "host", port: "port" }]
function parseUris(urisStr /*: any */) /*: Array<{ host: string, port: number }> */ {
  if (typeof urisStr !== 'string') return []
  const uris = urisStr.split(',')
  const out = []
  for (let i = 0; i < uris.length; i++) {
    const [host, port] = uris[i].split(':')
    out.push({ host, port: parseInt(port, 10) })
  }
  return out
}

module.exports = {
  getRelease,
  setPTimeout,
  hasOwnProperty,
  sampleArray,
  parseUris,
  writeHeader
}
