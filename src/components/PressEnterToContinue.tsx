import { Text } from '../ink/index.js'
export function PressEnterToContinue() {
  return (
    <Text color="permission">
      Press <Text bold={true}>Enter</Text> to continue…
    </Text>
  )
}
