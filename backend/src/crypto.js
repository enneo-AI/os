import crypto from 'node:crypto'

const PREFIX = 'enc:v1:'

function encryptionKey() {
  const encoded = process.env.CONNECTOR_ENCRYPTION_KEY || ''
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw new Error('CONNECTOR_ENCRYPTION_KEY muss ein Base64-kodierter 32-Byte-Key sein')
  return key
}

// Credentials verlassen den Server nie. AES-256-GCM schützt zusätzlich gegen
// versehentliche DB-Exporte; alte manuelle Tokens bleiben lesbar und werden beim
// nächsten OAuth-Connect automatisch durch verschlüsselte Werte ersetzt.
export function encryptSecret(value) {
  if (!value) return null
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`
}

export function decryptSecret(value) {
  if (!value || !value.startsWith(PREFIX)) return value || null
  const [ivPart, tagPart, encryptedPart] = value.slice(PREFIX.length).split('.')
  if (!ivPart || !tagPart || !encryptedPart) throw new Error('Ungültiges verschlüsseltes Credential')
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivPart, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}
