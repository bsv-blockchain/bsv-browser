import { WalletInterface } from '@bsv/sdk'

interface GetAppsParams {
  limit?: number
  offset?: number
  permissionsManager: WalletInterface
  adminOriginator: string
}

export const getApps = async ({
  limit = 10000,
  offset = 0,
  permissionsManager,
  adminOriginator
}: GetAppsParams): Promise<string[]> => {
  try {
    if (!permissionsManager || !permissionsManager.isAuthenticated) {
      return []
    }
    // Fetch transaction outputs from the specified basket.
    const { outputs } = await permissionsManager.listOutputs(
      {
        basket: 'admin protocol-permission',
        includeTags: true,
        includeLabels: true,
        limit,
        offset
      },
      adminOriginator
    )

    // Collect unique originator names from the outputs in reverse order (most recent first)
    const originatorNames: string[] = []
    const seen: Set<string> = new Set()

    // Iterate backwards so that the first occurrence is the most recent one.
    for (let i = outputs.length - 1; i >= 0; i--) {
      const output = outputs[i]
      if (output.tags && Array.isArray(output.tags)) {
        const originatorTag = output.tags.find(tag => tag.startsWith('originator'))
        if (originatorTag) {
          const name = originatorTag.substring('originator '.length)
          if (!seen.has(name)) {
            seen.add(name)
            originatorNames.push(name)
          }
        }
      }
    }

    return originatorNames
  } catch (error) {
    console.error('Error fetching app data:', error)
    return []
  }
}
