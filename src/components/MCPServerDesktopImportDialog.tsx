import { useEffect, useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { writeToStdout } from 'src/utils/process.js'
import { Box, color, Text, useTheme } from '../ink.js'
import { addMcpConfig, getAllMcpConfigs } from '../services/mcp/config.js'
import type { ConfigScope, McpServerConfig } from '../services/mcp/types.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { SelectMulti } from './CustomSelect/SelectMulti.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

type Props = {
  servers: Record<string, McpServerConfig>
  scope: ConfigScope
  onDone(): void
}
export function MCPServerDesktopImportDialog({ servers, scope, onDone }: Props) {
  const serverNames = Object.keys(servers)
  const [existingServers, setExistingServers] = useState({})
  useEffect(() => {
    getAllMcpConfigs().then((existingConfigs) => {
      const { servers: existingServerConfigs } = existingConfigs
      return setExistingServers(existingServerConfigs)
    })
  }, [])
  const collisions = serverNames.filter((name) => existingServers[name] !== undefined)
  const onSubmit = async function onSubmit(selectedServers) {
    let importedCount = 0
    for (const serverName of selectedServers) {
      const serverConfig = servers[serverName]
      if (serverConfig) {
        let finalName = serverName
        if (existingServers[finalName] !== undefined) {
          let counter = 1
          while (existingServers[`${serverName}_${counter}`] !== undefined) {
            counter++
          }
          finalName = `${serverName}_${counter}`
        }
        await addMcpConfig(finalName, serverConfig, scope)
        importedCount++
      }
    }
    done(importedCount)
  }
  const [theme] = useTheme()
  let done
  done = (importedCount) => {
    if (importedCount > 0) {
      writeToStdout(
        `\n${color('success', theme)(tSync('mcp.importSuccess', { count: importedCount, unit: tSync(importedCount === 1 ? 'mcp.importServer_one' : 'mcp.importServer_other'), scope }))}\n`,
      )
    } else {
      writeToStdout(tSync('mcp.importNoneImported'))
    }
    onDone()
    gracefulShutdown()
  }
  const handleEscCancel = () => {
    done(0)
  }
  const serverUnitLabel = tSync(
    serverNames.length === 1 ? 'mcp.importServer_one' : 'mcp.importServer_other',
  )
  const serverOptions = serverNames.map((server) => ({
    label: `${server}${collisions.includes(server) ? tSync('mcp.importAlreadyExists') : ''}`,
    value: server,
  }))
  const defaultSelectedServers = serverNames.filter((name) => !collisions.includes(name))
  return (
    <>
      {
        <Dialog
          title={tSync('mcp.importDesktopTitle')}
          subtitle={tSync('mcp.importDesktopSubtitle', {
            count: serverNames.length,
            unit: serverUnitLabel,
          })}
          color="success"
          onCancel={handleEscCancel}
          hideInputGuide={true}
        >
          {collisions.length > 0 && <Text color="warning">{tSync('mcp.importCollisionNote')}</Text>}
          {<Text>{tSync('mcp.importSelectServers')}</Text>}
          {
            <SelectMulti
              options={serverOptions}
              defaultValue={defaultSelectedServers}
              onSubmit={onSubmit}
              onCancel={handleEscCancel}
              hideIndexes={true}
            />
          }
        </Dialog>
      }
      {
        <Box paddingX={1}>
          <Text dimColor={true} italic={true}>
            <Byline>
              <KeyboardShortcutHint shortcut="Space" action="select" />
              <KeyboardShortcutHint shortcut="Enter" action="confirm" />
              <ConfigurableShortcutHint
                action="confirm:no"
                context="Confirmation"
                fallback="Esc"
                description="cancel"
              />
            </Byline>
          </Text>
        </Box>
      }
    </>
  )
}
