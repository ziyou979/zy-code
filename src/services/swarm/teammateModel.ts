import { parseUserSpecifiedModel } from '../model/model.js'

// When the user has never set teammateDefaultModel in /config, new teammates
// use the configured advanced-tier model. Resolves tier aliases and custom
// model aliases from settings.
export function getTeammateModelFallback(): string {
  return parseUserSpecifiedModel('advanced')
}
