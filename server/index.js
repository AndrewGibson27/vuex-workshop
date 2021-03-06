const fs = require('fs')
const path = require('path')
const LRU = require('lru-cache')
const express = require('express')
const spdy = require('spdy')
const compression = require('compression')
const bodyParser = require('body-parser')
const { createBundleRenderer } = require('vue-server-renderer')
const apiMiddleware = require('./api')

const resolve = file => path.resolve(__dirname, file)

const isProd = process.env.NODE_ENV === 'production'
const useMicroCache = process.env.MICRO_CACHE !== 'false'
const serverInfo =
  `express/${require('express/package.json').version} ` +
  `vue-server-renderer/${require('vue-server-renderer/package.json').version}`

// Allow self signed certificate in dev
if (!isProd || true) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // eslint-disable-line

const app = express()

// Ensure secure
app.all('*', (req, res, next) => {
  if (req.secure) return next()
  res.redirect(`https://${req.hostname}:${process.env.PORT_HTTPS || 3443}${req.url}`)
})

// Setup body parsing
app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())

apiMiddleware(app)

const template = fs.readFileSync(resolve('../src/index.template.html'), 'utf-8')

function createRenderer(bundle, options) {
  // https://github.com/vuejs/vue/blob/dev/packages/vue-server-renderer/README.md#why-use-bundlerenderer
  return createBundleRenderer(
    bundle,
    Object.assign(options, {
      template,
      // for component caching
      cache: LRU({ max: 1000, maxAge: 1000 * 60 * 15 }),
      // this is only needed when vue-server-renderer is npm-linked
      basedir: resolve('../dist'),
      // recommended for performance
      runInNewContext: false,
    }),
  )
}

let renderer
let readyPromise
if (isProd) {
  // In production: create server renderer using built server bundle.
  // The server bundle is generated by vue-ssr-webpack-plugin.
  const bundle = require('../dist/vue-ssr-manifest.json')
  // The client manifests are optional, but it allows the renderer
  // to automatically infer preload/prefetch links and directly add <script>
  // tags for any async chunks used during render, avoiding waterfall requests.
  const clientManifest = require('../dist/vue-client-manifest.json')
  renderer = createRenderer(bundle, { clientManifest })
} else {
  // In development: setup the dev server with watch and hot-reload,
  // and create a new renderer on bundle / index template update.
  readyPromise = require('./dev')(app, (bundle, options) => {
    renderer = createRenderer(bundle, options)
  })
}

const serve = (path, cache) =>
  express.static(resolve(path), {
    maxAge: cache && isProd ? 1000 * 60 * 60 * 24 * 30 : 0,
  })

app.use(compression({ threshold: 0 }))
app.use('/assets', serve('../dist/assets', true))
app.use('/static', serve('../static', true))
app.use('/sw.js', serve('../dist/sw.js'))

// 1-second microcache.
// https://www.nginx.com/blog/benefits-of-microcaching-nginx/
const microCache = LRU({ max: 100, maxAge: 1000 })

// since this app has no user-specific content, every page is micro-cacheable.
// if your app involves user-specific content, you need to implement custom
// logic to determine whether a request is cacheable based on its url and
// headers.
const isCacheable = req => useMicroCache

function render(req, res) {
  const s = Date.now()

  res.setHeader('Content-Type', 'text/html')
  res.setHeader('Server', serverInfo)

  const cacheable = isCacheable(req)
  if (cacheable) {
    const hit = microCache.get(req.url)
    if (hit) {
      if (!isProd) console.log(`cache hit!`)
      return res.end(hit)
    }
  }

  const context = { url: req.url }
  renderer.renderToString(context, (failure, html) => {
    const { error } = context.state.context
    res.status(error ? error.status : 200).end(html)
    if (failure) console.error(`Critical: ${failure.message}`)
    if (cacheable) microCache.set(req.url, html)
    if (!isProd) console.log(`whole request: ${Date.now() - s}ms`)
  })
}

app.get(
  '*',
  isProd
    ? render
    : (req, res) => {
        readyPromise.then(() => render(req, res))
      },
)

const https = spdy.createServer(
  {
    requestCert: false,
    rejectUnauthorized: false,
    key: fs.readFileSync(path.resolve(__dirname, '../certificate/key.pem')),
    cert: fs.readFileSync(path.resolve(__dirname, '../certificate/cert.pem')),
  },
  app,
)

https.listen(process.env.PORT_HTTPS || 3443, error => {
  if (error) {
    console.error(error)
    return process.exit(1)
  }
  return console.log(`App running in HTTPS on port: ${process.env.PORT_HTTPS || 3443}.`)
})

app.listen(process.env.PORT || 8080, error => {
  if (error) {
    console.error(error)
    return process.exit(1)
  }
  return console.log(`App running in HTTP on port: ${process.env.PORT || 8080}.`)
})
