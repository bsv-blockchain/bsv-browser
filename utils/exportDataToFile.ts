import { useContext } from 'react'
import { UserContext } from '@bsv/expo-wallet-toolbox/core/context/UserContext'

/**
 * Interface for export data parameters
 */
interface ExportDataParams {
  data: any
  filename: string
  type: string
}

/**
 * Hook that returns a function to export data to a file using the UserContext download handler.
 *
 * @returns {Function} The exportDataToFile function
 */
export const useExportDataToFile = () => {
  const { onDownloadFile } = useContext(UserContext)

  /**
   * Exports data to a file with a specified format and filename.
   *
   * @param {ExportDataParams} params - The parameters object.
   * @param {*} params.data - The data to be exported.
   * @param {string} params.filename - The filename for the exported file.
   * @param {string} params.type - The MIME type of the file.
   * @returns {Promise<boolean>} - A promise that resolves to true if successful
   */
  return async ({ data, filename, type }: ExportDataParams): Promise<boolean> => {
    let exportedData: string

    // Depending on the MIME type, process the data accordingly
    if (type === 'application/json') {
      exportedData = JSON.stringify(data, null, 2)
    } else if (type === 'text/plain') {
      exportedData = String(data)
    } else {
      throw new Error('Unsupported file type')
    }

    // Create a new Blob object using the processed data
    const blob = new Blob([exportedData], { type })

    // Use the download handler from UserContext
    return await onDownloadFile(blob, filename)
  }
}

/**
 * Hook that returns a function to download binary files using the UserContext download handler.
 *
 * @returns {Function} The downloadBinaryFile function
 */
export const useDownloadBinaryFile = () => {
  const { onDownloadFile } = useContext(UserContext)

  /**
   * Downloads a binary file with the specified filename and content.
   *
   * @param {string} filename - The name of the file to be downloaded
   * @param {number[]} fileContent - The binary content as an array of numbers
   * @returns {Promise<boolean>} - A promise that resolves to true if successful, false otherwise
   */
  return async (filename: string, fileContent: number[]): Promise<boolean> => {
    try {
      // Convert array to Uint8Array for binary data
      const content = new Uint8Array(fileContent)

      // Create a blob from the binary data
      const blob = new Blob([content])

      // Use the download handler from UserContext
      return await onDownloadFile(blob, filename)
    } catch (e) {
      console.error('Download error:', e)
      return false
    }
  }
}
