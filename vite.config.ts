import { createLogger, defineConfig } from 'vite'

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

export default defineConfig({
  customLogger: logger,
  server: {
    host: '0.0.0.0',
    proxy: {
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
  },
})
