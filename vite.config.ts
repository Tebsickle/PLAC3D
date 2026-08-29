import { createLogger, defineConfig, loadEnv } from 'vite'

const logger = createLogger()
const logError = logger.error.bind(logger)
logger.error = (message, options) => {
  const errorCode = (options?.error as { code?: string } | undefined)?.code
  const isExpectedWebSocketReset =
    errorCode === 'ECONNRESET' &&
    (message.includes('ws proxy error') ||
      message.includes('ws proxy socket error'))
  if (isExpectedWebSocketReset) return
  logError(message, options)
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appPort = Number(env.APP_PORT || 5173)
  const serverPort = Number(env.PORT || 8787)

  return {
    customLogger: logger,
    server: {
      host: '0.0.0.0',
      port: appPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${serverPort}`,
        },
        '/ws': {
          target: `ws://127.0.0.1:${serverPort}`,
          ws: true,
        },
      },
    },
  }
})
