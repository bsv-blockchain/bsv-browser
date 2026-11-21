/** Display-only interpretation of DPACP action-label scopes. Never grants access. */
export function parseActionLabelPermission(
  securityLevel: number,
  protocol: string
): {
  label: string
  operation: 'apply' | 'list' | 'both'
  title: string
  description: string
  metadataProtocol: string
} | null {
  if (securityLevel !== 1) return null
  const scoped = /^admin label (apply|list) (.+)$/s.exec(protocol)
  const legacy = /^action label (.+)$/s.exec(protocol)
  if (!scoped && !legacy) return null
  const label = scoped?.[2] ?? legacy![1]
  const operation = scoped ? (scoped[1] as 'apply' | 'list') : 'both'
  return {
    label,
    operation,
    title:
      operation === 'apply'
        ? 'Add transaction labels'
        : operation === 'list'
          ? 'Read labeled history'
          : 'Label access: apply and read',
    description:
      operation === 'apply'
        ? `Add “${label}” to transactions the app creates.`
        : operation === 'list'
          ? `Read wallet transactions labeled “${label}”, including matching activity from other apps.`
          : `Apply “${label}” to new transactions and read all matching wallet history. This existing grant covers both operations.`,
    metadataProtocol: `action label ${label}`
  }
}
