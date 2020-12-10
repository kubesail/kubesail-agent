// @flow

const net = require('net')
const https = require('https')

const logger = require('./logger')
const { INTERNAL_HTTPS_RESPONDER_PORT, KUBESAIL_API_TARGET } = require('./config')

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
  socket /*: net.Socket */,
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

function getWeek(dowOffset) {
  const date = new Date()
  /* getWeek() was developed by Nick Baicoianu at MeanFreePath: http://www.meanfreepath.com */
  dowOffset = typeof dowOffset === 'number' ? dowOffset : 0 // default dowOffset to zero
  var newYear = new Date(date.getFullYear(), 0, 1)
  var day = newYear.getDay() - dowOffset // the day of week the year begins on
  day = day >= 0 ? day : day + 7
  var daynum =
    Math.floor(
      (date.getTime() -
        newYear.getTime() -
        (date.getTimezoneOffset() - newYear.getTimezoneOffset()) * 60000) /
        86400000
    ) + 1
  var weeknum
  // if the year starts before the middle of a week
  if (day < 4) {
    weeknum = Math.floor((daynum + day - 1) / 7) + 1
    if (weeknum > 52) {
      const nYear = new Date(date.getFullYear() + 1, 0, 1)
      let nday = nYear.getDay() - dowOffset
      nday = nday >= 0 ? nday : nday + 7
      /* if the next year starts before the middle of
                the week, it is week #1 of that year */
      weeknum = nday < 4 ? 1 : 53
    }
  } else {
    weeknum = Math.floor((daynum + day - 1) / 7)
  }
  return weeknum
}

const [KubeSailApiTarget, KubeSailApiPort] = KUBESAIL_API_TARGET.split(':')
const maxApiRequestRetries = 500
// Makes HTTPS requests to KubeSail API for things like agent disconnection / registration, etc
// kubesailApiReqest is a simple wrapper around `https.request`.
// This could probably be replaced by `got` or something modern
function kubesailApiReqest(
  method,
  path,
  data,
  retries = 0
) /*: Promise<{ json: any, status: number }> */ {
  return new Promise((resolve, reject) => {
    const options /*: Object */ = {
      hostname: KubeSailApiTarget,
      headers: { 'Content-Type': 'application/json' },
      port: KubeSailApiPort,
      method
    }
    if (process.env.NODE_ENV === 'development') {
      options.insecure = true
      options.rejectUnauthorized = false
    }
    const req = https.request({ ...options, path }, res => {
      res.on('error', err => {
        logger.error('Gateway got error talking to KubeSail Api on socket disconnect!', {
          errMsg: err.message,
          code: err.code
        })
      })
      let buff = ''
      res.on('data', data => {
        buff = buff + data
      })
      res.on('close', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(buff) })
        } catch (err) {
          logger.error('Gateway failed to parse response from KubeSail API! Buffer was:', {
            buff,
            status: res.statusCode
          })
        }
      })
    })
    req.on('error', e => {
      logger.error('Gateway Failed to post event to KubeSail API', {
        errMsg: e.message,
        code: e.code,
        type: e.type,
        retries
      })
      if (retries >= maxApiRequestRetries) {
        if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EAGAIN') {
          return setTimeout(() => {
            resolve(kubesailApiReqest(method, path, data, ++retries))
          }, retries * 1000)
        }
      }
      reject(new Error('Failed to post message to KubeSail API'))
    })

    if (data) {
      req.write(JSON.stringify(data))
    }
    req.end()
  })
}

module.exports = {
  setPTimeout,
  hasOwnProperty,
  sampleArray,
  writeHeader,
  getWeek,
  kubesailApiReqest
}
