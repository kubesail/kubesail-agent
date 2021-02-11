// @flow

const http = require('http')
const https = require('https')
// $FlowIssue
const { expect } = require('chai')

const { GATEWAY_HTTP_LISTEN_PORT, GATEWAY_HTTPS_LISTEN_PORT } = require('../../lib/shared/config')

const httpReqOpts = {
  hostname: 'kubesail-gateway',
  port: GATEWAY_HTTP_LISTEN_PORT,
  method: 'GET'
}
const httpsReqOpts = {
  hostname: 'kubesail-gateway',
  port: GATEWAY_HTTPS_LISTEN_PORT,
  method: 'GET',
  insecure: true,
  rejectUnauthorized: false
}

const describe = global.describe
const it = global.it

describe('Gateway tests', function () {
  describe('HTTP Tunnel handling', function () {
    it('Returns a 501 when a no host header is provided', function (done) {
      const req = http.request(httpReqOpts, res => {
        expect(res.statusCode).to.equal(501)
        done()
      })
      req.on('error', error => {
        console.error(error)
      })
      req.end()
    })

    it('Returns a 502 when a bad host is requested', function (done) {
      const req = http.request(
        Object.assign({}, httpReqOpts, {
          headers: { host: 'foobar.com' }
        }),
        res => {
          expect(res.statusCode).to.equal(502)
          done()
        }
      )
      req.on('error', error => {
        console.error(error)
      })
      req.end()
    })

    it('Returns a 200 when a good host is requested (test-endpoint.example.com)', function (done) {
      const req = http.request(
        Object.assign({}, httpReqOpts, {
          headers: { host: 'test-endpoint.example.com' }
        }),
        res => {
          res.once('data', data => {
            const json = JSON.parse(data.toString())
            expect(json.ok).to.equal(true)
          })
          res.on('end', () => {
            expect(res.statusCode).to.equal(200)
            done()
          })
        }
      )
      req.on('error', error => {
        console.error(error)
      })
      req.end()
    })
  })

  describe('HTTPS Tunnel handling', function () {
    it('Drops the connection when given a bad host', function (done) {
      const req = https.request(
        Object.assign({}, httpsReqOpts, {
          headers: { host: 'foobar.com' }
        }),
        res => {
          expect(res.statusCode).to.equal(503)
          done()
        }
      )
      req.on('error', error => {
        console.error('Drops the connection test error', error)
      })
      req.end()
    })

    it('Returns a 200 when a good host is requested (qotm end-to-end)', function (done) {
      const req = https.request(
        Object.assign({}, httpsReqOpts, {
          headers: { host: 'test-endpoint.example.com' },
          path: '/qotm'
        }),
        res => {
          expect(res.statusCode).to.equal(200)
          res.on('data', data => {
            expect(JSON.parse(data.toString()).quote).to.be.a('string')
            done()
          })
        }
      )
      req.on('error', error => {
        console.error('Returns a 200 when a good host', error)
      })
      req.end()
    })

    it('Routes to the Kube API when using the clusterAddress', function (done) {
      const req = https.request(
        Object.assign({}, httpsReqOpts, {
          headers: { host: 'a-dev-cluster.erulabs.kubesail-gateway.default.svc.cluster.local' },
          path: '/'
        }),
        res => {
          expect(res.statusCode).to.equal(403)
          done()
        }
      )
      req.on('error', error => {
        console.error('Routes to the Kube API when using the clusterAddress', error)
      })
      req.end()
    })

    it('Handles a lot of requests concurrently', function (done) {
      const NUM_REQUESTS = 100
      let count = 0
      const loopDone = () => {
        if (++count === NUM_REQUESTS) {
          done()
        }
      }
      for (let i = 0; i < NUM_REQUESTS; i++) {
        const req = https.request(
          Object.assign({}, httpsReqOpts, {
            headers: { host: 'test-endpoint.example.com' },
            path: '/qotm'
          }),
          res => {
            expect(res.statusCode).to.equal(200)
            res.on('data', data => {
              expect(JSON.parse(data.toString()).quote).to.be.a('string')
              loopDone()
            })
          }
        )
        req.on('error', error => {
          console.error('Returns a 200 when a good host', error)
        })
        req.end()
      }
    })

    // it('Returns a 403 from the kube-api server', function(done) {
    //   const req = https.request(
    //     Object.assign({}, httpsReqOpts, {
    //       headers: { host: 'mycluster.erulabs.kubesail-gateway.default.svc.cluster.local' },
    //       path: '/openapi/v2'
    //     }),
    //     res => {
    //       expect(res.statusCode).to.equal(403)
    //       res.on('data', data => {
    //         expect(JSON.parse(data.toString()).reason).to.equal('Forbidden')
    //         done()
    //       })
    //     }
    //   )
    //   req.end()
    // })
  })
})
