import { useEffect } from 'react'
import { CROSS, POINTER, TICK, WARNING } from '../../constants/figures.js'
import { Box, Text } from '../../ink/index.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../services/infra/log.js'
import { validateManifest } from '../../services/plugins/validatePlugin.js'
import { plural } from '../../utils/stringUtils.js'

type Props = {
  onComplete: (result?: string) => void
  path?: string
}
export function ValidatePlugin({ onComplete, path }: Props) {
  useEffect(() => {
    const runValidation = async function runValidation() {
      if (!path) {
        onComplete(
          'Usage: /plugin validate <path>\n\nValidate a plugin or marketplace manifest file or directory.\n\nExamples:\n  /plugin validate .zy-plugin/plugin.json\n  /plugin validate /path/to/plugin-directory\n  /plugin validate .\n\nWhen given a directory, automatically validates .zy-plugin/marketplace.json\nor .zy-plugin/plugin.json (prefers marketplace if both exist).\n\nOr from the command line:\n  zy plugin validate <path>',
        )
        return
      }
      try {
        const result = await validateManifest(path)
        let output = ''
        output = `${output}Validating ${result.fileType} manifest: ${result.filePath}\n\n`
        if (result.errors.length > 0) {
          output =
            output +
            `${CROSS} Found ${result.errors.length} ${plural(result.errors.length, 'error')}:\n\n`
          result.errors.forEach((error_0) => {
            output = `${output}  ${POINTER} ${error_0.path}: ${error_0.message}\n`
          })
          output = `${output}\n`
        }
        if (result.warnings.length > 0) {
          output =
            output +
            `${WARNING} Found ${result.warnings.length} ${plural(result.warnings.length, 'warning')}:\n\n`
          result.warnings.forEach((warning) => {
            output = `${output}  ${POINTER} ${warning.path}: ${warning.message}\n`
          })
          output = `${output}\n`
        }
        if (result.success) {
          if (result.warnings.length > 0) {
            output = `${output}${TICK} Validation passed with warnings\n`
          } else {
            output = `${output}${TICK} Validation passed\n`
          }
          process.exitCode = 0
        } else {
          output = `${output}${CROSS} Validation failed\n`
          process.exitCode = 1
        }
        onComplete(output)
      } catch (error) {
        process.exitCode = 2
        logError(error)
        onComplete(`${CROSS} Unexpected error during validation: ${errorMessage(error)}`)
      }
    }
    runValidation()
  }, [onComplete, path])
  return (
    <Box flexDirection="column">
      <Text>Running validation...</Text>
    </Box>
  )
}
