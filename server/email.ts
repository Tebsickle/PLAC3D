import { createHash } from 'node:crypto'

type EmailMessage = {
  to: string
  subject: string
  html: string
  text: string
  idempotencySource: string
}

const resendApiKey = process.env.RESEND_API_KEY?.trim() ?? ''
const fromEmail = process.env.RESEND_FROM_EMAIL?.trim() ?? ''
const isProduction = process.env.NODE_ENV === 'production'

export const sendEmail = async (message: EmailMessage) => {
  if (!resendApiKey) {
    if (isProduction)
      throw new Error('RESEND_API_KEY is required in production.')
    return { delivered: false as const }
  }
  if (!fromEmail)
    throw new Error('RESEND_FROM_EMAIL is required when email delivery is enabled.')

  const idempotencyKey = createHash('sha256')
    .update(message.idempotencySource)
    .digest('hex')
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resendApiKey}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
      'user-agent': 'PLAC3D/0.0.0',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  })

  if (!response.ok) {
    const detail = await response.text()
    throw new Error(
      `Resend rejected the email (${response.status}): ${detail.slice(0, 500)}`,
    )
  }
  return { delivered: true as const }
}
