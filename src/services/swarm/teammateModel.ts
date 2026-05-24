import { QWEN_3_6_PLUS_CONFIG } from '../../utils/model/configs.js'
import { getAPIProvider } from '../../utils/model/providers.js'

// When the user has never set teammateDefaultModel in /config, new teammates
// use the default model. Must be provider-aware so Bedrock/Vertex/Foundry customers get
// the correct model ID.
export function getHardcodedTeammateModelFallback(): string {
  return QWEN_3_6_PLUS_CONFIG[getAPIProvider()]
}
