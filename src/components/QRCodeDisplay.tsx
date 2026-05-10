import { toString as qrToString } from 'qrcode'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, Text } from '../ink.js'

type QRCodeDisplayProps = {
  displayUrl: string | undefined
  showQR: boolean
}

/**
 * QR 码展示组件
 * 根据 URL 生成 ASCII QR 码并渲染
 */
export function QRCodeDisplay({ displayUrl, showQR }: QRCodeDisplayProps) {
  const [qrText, setQrText] = useState('')

  useEffect(() => {
    if (!showQR || !displayUrl) {
      setQrText('')
      return
    }
    // @ts-ignore
    qrToString(displayUrl, {
      type: 'utf8',
      errorCorrectionLevel: 'L',
      small: true,
    })
      .then(setQrText)
      .catch(() => setQrText(''))
  }, [showQR, displayUrl])

  const qrLines = qrText ? qrText.split('\n').filter((line) => line.length > 0) : []

  if (!showQR || qrLines.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column">
      {qrLines.map((line, lineIndex) => (
        <Text key={lineIndex}>{line}</Text>
      ))}
    </Box>
  )
}
